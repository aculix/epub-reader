import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, type Book, type EpubLocation } from '../lib/api';
import { EpubBook } from './loadEpub';
import ReaderShell, { type ShellTocEntry } from '../reader/ReaderShell';
import { READER_THEMES, useReaderSettings, type ReaderFont, type ReaderTheme } from '../reader/readerSettings';
import { clamp } from '../lib/format';
import { clearTurn, prepareTurn, runTurn, setTurnProgress, type TurnRun, type TurnMode, type TurnElements } from './pageCurl';

import literataUrl from '@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url';
import literataItalicUrl from '@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url';
import sansUrl from '@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2?url';

const FONT_STACKS: Record<ReaderFont, string> = {
  literata: `'Literata', 'Iowan Old Style', Georgia, serif`,
  georgia: `Georgia, 'Times New Roman', serif`,
  sans: `'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif`,
};

const PAD_V = 64;
const COL_GAP = 72;
const TURN_MS = 330;
// The reading surface fills the viewport (Play Books-style, no floating "book"
// object) — text columns are centred with generous margins on wide screens.
const MAX_SPREAD_W = 1280;
const MAX_SINGLE_W = 720;

/**
 * Page geometry. The content box is sized to EXACTLY cols*colW + (cols-1)*gap
 * (leftover pixels absorbed into padding) so the browser's computed column
 * width matches ours — otherwise fractional column widths make translateX
 * drift off the column grid and clip glyphs at the page edge.
 */
function computeGeometry(stage: { w: number; h: number }, spread: 'auto' | 'single' | 'double') {
  const cols = spread === 'single' ? 1 : spread === 'double' ? 2 : stage.w >= 920 ? 2 : 1;
  const maxW = cols === 2 ? MAX_SPREAD_W : MAX_SINGLE_W;
  const basePad = stage.w < 640 ? 28 : Math.max(64, Math.round((stage.w - maxW) / 2));
  const innerW = stage.w - basePad * 2;
  const colW = Math.floor((innerW - (cols - 1) * COL_GAP) / cols);
  const leftover = innerW - (cols * colW + (cols - 1) * COL_GAP);
  const padLeft = basePad + Math.floor(leftover / 2);
  const padRight = basePad + (leftover - Math.floor(leftover / 2));
  return { cols, colW, padLeft, padRight, innerH: stage.h - PAD_V * 2, stepW: cols * (colW + COL_GAP) };
}

interface Layout {
  cols: number; // visible columns (1 or 2)
  colW: number;
  stepW: number; // translate distance for one page turn = cols * (colW + gap)
  groups: number; // number of page positions in this chapter
  totalColumns: number;
}

export default function EpubReader({ book: bookMeta }: { book: Book }) {
  const [settings, updateSettings] = useReaderSettings();
  const theme = READER_THEMES[settings.theme];

  const [epub, setEpub] = useState<EpubBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spineIndex, setSpineIndex] = useState(0);
  const [group, setGroup] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [chapterVisible, setChapterVisible] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  // Two stacked page layers: the moving page pivots away while the destination
  // page waits underneath. `frontIdx` is the layer showing the current page.
  const layerRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)] as const;
  const frameRefs = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)] as const;
  const clipRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)] as const;
  const innerRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)] as const;
  const flapRef = useRef<HTMLDivElement>(null);
  const shadeRef = useRef<HTMLDivElement>(null);
  const frontIdxRef = useRef(0);
  /** Page group each layer is currently parked on, so a turn can skip
      re-parking (moving a huge column strip forces a fresh rasterisation,
      which is visible as a flash mid-gesture). */
  const layerGroupRef = useRef<[number | null, number | null]>([null, null]);
  const curlRunRef = useRef<TurnRun | null>(null);
  /** The in-flight turn, so a turn interrupted by the next one still lands
      instead of stranding a layer raised and non-interactive. */
  const liveTurnRef = useRef<{ settle: () => void } | null>(null);
  const turningRef = useRef(false);
  const layoutRef = useRef<Layout | null>(null);
  const groupRef = useRef(0);
  const spineRef = useRef(0);
  const epubRef = useRef<EpubBook | null>(null);
  const navDirRef = useRef<1 | -1>(1);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSaved = useRef<{ percent: number; location: EpubLocation } | null>(null);
  // Where to land once the incoming chapter is measured
  const pendingTarget = useRef<{ fraction?: number; hash?: string; end?: boolean }>({ fraction: 0 });
  // Blocks next/prev while a chapter is loading, so holding an arrow key at a
  // boundary can't act on stale group/layout refs and skip chapters.
  const loadingChapterRef = useRef(false);
  // Page group of each same-chapter TOC anchor, so the context label and TOC
  // highlight track sub-sections within a chapter file, not just the file.
  const anchorGroupsRef = useRef(new Map<number, number>());

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  groupRef.current = group;
  spineRef.current = spineIndex;
  epubRef.current = epub;

  // ---------- open the book ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(api.fileUrl(bookMeta.id));
        if (!res.ok) throw new Error(`Could not download the book (${res.status})`);
        const data = await res.arrayBuffer();
        const opened = await EpubBook.open(data);
        if (cancelled) { opened.destroy(); return; }
        const loc = bookMeta.progress?.location;
        if (loc && loc.kind === 'epub' && loc.spineIndex < opened.spine.length) {
          pendingTarget.current = { fraction: loc.fraction };
          setSpineIndex(loc.spineIndex);
        }
        setEpub(opened);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to open this ePUB');
      }
    })();
    return () => {
      cancelled = true;
      epubRef.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookMeta.id]);

  // ---------- srcdoc for current chapter ----------
  const [srcdoc, setSrcdoc] = useState<string | null>(null);
  const stageSize = useStageSize(stageRef);

  const geometry = useMemo(
    () => (stageSize ? computeGeometry(stageSize, settings.spread) : null),
    [stageSize, settings.spread]
  );

  const injectedCss = useMemo(() => {
    if (!stageSize || !geometry) return '';
    const { colW, padLeft, padRight, innerH } = geometry;
    return `
      @font-face { font-family: 'Literata'; src: url('${literataUrl}') format('woff2-variations'); font-weight: 200 900; font-style: normal; font-display: swap; }
      @font-face { font-family: 'Literata'; src: url('${literataItalicUrl}') format('woff2-variations'); font-weight: 200 900; font-style: italic; font-display: swap; }
      @font-face { font-family: 'Schibsted Grotesk'; src: url('${sansUrl}') format('woff2-variations'); font-weight: 400 900; font-style: normal; font-display: swap; }
      html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent !important; }
      /* id + !important so publisher body classes (e.g. Calibre's) can't shift the page grid */
      #quire-body {
        margin: 0 !important;
        padding: ${PAD_V}px ${padRight}px ${PAD_V}px ${padLeft}px !important;
        box-sizing: border-box !important;
        width: 100% !important;
        max-width: none !important;
      }
      #quire-root {
        height: ${innerH}px;
        column-width: ${colW}px;
        column-gap: ${COL_GAP}px;
        column-fill: auto;
        /* The strip is positioned instantly (the page layer does the moving),
           so it must NOT be promoted: it is thousands of pixels wide and
           will-change would hand the GPU a huge texture per layer. */
        font-family: ${FONT_STACKS[settings.font]};
        font-size: ${settings.fontSize}px;
        line-height: ${settings.lineHeight};
        color: ${theme.text};
        -webkit-font-smoothing: antialiased;
      }
      #quire-root :where(p, li, blockquote, dd, dt) {
        line-height: inherit;
      }
      ${!settings.pubStyles ? `
      /* "Quire style": publisher fonts & colors are normalized for legibility.
         Structure (margins, indents, sizes, italics, small-caps) is preserved. */
      #quire-root :where(*):not(pre, code, kbd, samp, svg, svg *) {
        font-family: inherit !important;
        color: inherit !important;
        background-color: transparent !important;
      }
      #quire-root :where(p, li, blockquote, dd) {
        hyphens: auto;
        -webkit-hyphens: auto;
        hyphenate-limit-chars: 7 4 3;
        overflow-wrap: break-word;
      }
      ` : ''}
      ${settings.theme === 'dusk' ? `#quire-root :where(p, li, blockquote, h1, h2, h3, h4, h5, h6, span, div, em, strong, i, b, small, td, th, dt, dd, figcaption) { color: inherit !important; background: transparent !important; }` : ''}
      #quire-root :where(h1, h2, h3, h4, h5, h6) { break-after: avoid; }
      #quire-root :where(img, svg, image, video) {
        max-width: 100% !important;
        max-height: ${innerH - 8}px !important;
        object-fit: contain;
        break-inside: avoid;
      }
      #quire-root :where(figure) { break-inside: avoid; margin-inline: 0; }
      #quire-root :where(pre) { white-space: pre-wrap; overflow-wrap: break-word; }
      #quire-root :where(table) { max-width: 100%; }
      #quire-root a, #quire-root a * { color: ${theme.accent} !important; }
      #quire-root a[data-quire-href] { cursor: pointer; text-decoration: underline; }
      ::selection { background: ${theme.accent}44; }
      @media (prefers-reduced-motion: reduce) {
        #quire-root { transition: none !important; }
      }
    `;
  }, [stageSize, geometry, settings, theme]);

  useEffect(() => {
    if (!epub || !stageSize) return;
    // Preserve the current position across settings/resize reloads unless an
    // explicit navigation target (open/seek/toc/link) is already pending.
    const t = pendingTarget.current;
    const lay = layoutRef.current;
    if (t.fraction == null && !t.hash && !t.end && lay) {
      pendingTarget.current = {
        fraction: lay.totalColumns <= lay.cols ? 0 : (groupRef.current * lay.cols) / lay.totalColumns,
      };
    }
    loadingChapterRef.current = true;
    layerGroupRef.current = [null, null];
    let cancelled = false;
    setChapterVisible(false);
    epub.prepareChapter(spineIndex).then((ch) => {
      if (cancelled) return;
      setSrcdoc(ch.html.replace('</head>', `<style id="quire-style">${injectedCss}</style></head>`));
    }).catch(() => {
      if (!cancelled) setError('Failed to render this chapter');
    });
    return () => { cancelled = true; };
    // injectedCss changes (settings/resize) intentionally re-render the chapter
  }, [epub, spineIndex, injectedCss, stageSize]);

  // ---------- measurement + positioning ----------
  /** The layer currently showing the reader's page. */
  const frontFrame = useCallback(() => frameRefs[frontIdxRef.current].current, [frameRefs]);

  /** Park a layer's column strip on a page group. Always instant — the curl
      provides the motion, so the strip itself never animates. */
  const placeLayer = useCallback((layerIdx: number, g: number) => {
    if (layerGroupRef.current[layerIdx] === g) return; // already rasterised there
    const root = frameRefs[layerIdx].current?.contentDocument?.getElementById('quire-root');
    const lay = layoutRef.current;
    if (!root || !lay) return;
    const sign = epubRef.current?.pageProgression === 'rtl' ? 1 : -1;
    root.style.transition = 'none';
    root.style.transform = `translateX(${sign * g * lay.stepW}px)`;
    layerGroupRef.current[layerIdx] = g;
  }, [frameRefs]);

  /**
   * Park the hidden layer on the page the reader is most likely to want next,
   * while nothing is moving. Doing this during a gesture makes the browser
   * rasterise a fresh slice of the strip mid-drag, which shows up as a flash.
   */
  const prestageNext = useCallback((fromGroup: number) => {
    const lay = layoutRef.current;
    if (!lay) return;
    const back = 1 - frontIdxRef.current;
    const target = Math.min(lay.groups - 1, fromGroup + 1);
    placeLayer(back, target);
  }, [placeLayer]);

  /** Position the visible page without any turn animation. */
  const applyGroup = useCallback((g: number) => {
    placeLayer(frontIdxRef.current, g);
  }, [placeLayer]);

  const measureAndPlace = useCallback(() => {
    const iframe = frontFrame();
    const doc = iframe?.contentDocument;
    const root = doc?.getElementById('quire-root');
    if (!doc || !root || !stageSize) return;

    const { cols, colW, stepW, padLeft } = computeGeometry(stageSize, settings.spread);
    const totalW = root.scrollWidth;
    const totalColumns = Math.max(1, Math.round((totalW + COL_GAP) / (colW + COL_GAP)));
    const groups = Math.max(1, Math.ceil(totalColumns / cols));
    const lay: Layout = { cols, colW, stepW, groups, totalColumns };
    layoutRef.current = lay;
    setLayout(lay);

    // Where does each TOC anchor of THIS chapter land, in page groups?
    const rtlBook = epubRef.current?.pageProgression === 'rtl';
    const groupForElement = (el: HTMLElement) => {
      const rawCol = Math.floor(Math.max(0, el.offsetLeft - padLeft) / (colW + COL_GAP));
      const colIdx = rtlBook ? Math.max(0, totalColumns - 1 - rawCol) : rawCol;
      return clamp(Math.floor(colIdx / cols), 0, groups - 1);
    };
    anchorGroupsRef.current = new Map();
    epubRef.current?.toc.forEach((entry, i) => {
      if (entry.spineIndex !== spineRef.current) return;
      const hash = entry.href.includes('#') ? entry.href.split('#')[1] : null;
      const el = hash ? doc.getElementById(hash) : null;
      anchorGroupsRef.current.set(i, el ? groupForElement(el as HTMLElement) : 0);
    });

    // Resolve the pending target into a page group
    const t = pendingTarget.current;
    const rtl = rtlBook;
    let g = 0;
    if (t.end) {
      g = groups - 1;
    } else if (t.hash) {
      const el = doc.getElementById(t.hash.slice(1));
      if (el) {
        // offsetLeft is layout-based (transform-independent); in RTL multicol
        // the first reading column sits at the far right.
        const rawCol = Math.floor(Math.max(0, (el as HTMLElement).offsetLeft - padLeft) / (colW + COL_GAP));
        const colIdx = rtl ? Math.max(0, totalColumns - 1 - rawCol) : rawCol;
        g = clamp(Math.floor(colIdx / cols), 0, groups - 1);
      }
    } else if (t.fraction != null) {
      // Exact inverse of the save formula (fraction = g*cols/totalColumns)
      g = clamp(Math.round((t.fraction * totalColumns) / cols), 0, groups - 1);
    }
    pendingTarget.current = {};
    setGroup(g);
    // Place BOTH layers: the back frame's own load handler runs before layout
    // exists whenever it wins the race, and would otherwise stay on page 0 —
    // making the first turn of every chapter jump a fully unrasterised page.
    placeLayer(frontIdxRef.current, g);
    setChapterVisible(true);
    loadingChapterRef.current = false;
    prestageNext(g);
  }, [stageSize, settings.spread, placeLayer, prestageNext, frontFrame]);

  // ---------- navigation ----------
  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const lay = layoutRef.current;
      const ep = epubRef.current;
      if (!lay || !ep) return;
      const fraction = lay.totalColumns <= lay.cols ? 0 : (groupRef.current * lay.cols) / lay.totalColumns;
      const location: EpubLocation = { kind: 'epub', spineIndex: spineRef.current, fraction };
      const percent = ep.progressFor(spineRef.current, fraction);
      lastSaved.current = { percent, location };
      api.saveProgress(bookMeta.id, percent, location).catch(() => {});
    }, 700);
  }, [bookMeta.id]);

  /**
   * Build the curl handle for a turn: parks the destination page on the other
   * layer, decides which layer physically moves, and stacks them.
   *
   * Forward, the OUTGOING page peels away (progress 0 → 1). Backward, the
   * INCOMING page unpeels back into place (progress 1 → 0) — the same physical
   * motion played in reverse.
   */
  const beginTurn = useCallback((targetGroup: number, dir: 1 | -1) => {
    const other = 1 - frontIdxRef.current;
    const rtlBook = epubRef.current?.pageProgression === 'rtl';
    placeLayer(other, targetGroup);

    // The destination page is ALWAYS the one uncovered; the page being left
    // never moves. Forward turns uncover from the trailing edge, backward
    // turns from the spine edge — the same peel, mirrored.
    const overIdx = other;
    const restingIdx = frontIdxRef.current;
    const overLayer = layerRefs[overIdx].current;
    const resting = layerRefs[restingIdx].current;
    const clip = clipRefs[overIdx].current;
    const inner = innerRefs[overIdx].current;
    const flap = flapRef.current;
    const shade = shadeRef.current;
    const width = stageRef.current?.clientWidth ?? 0;
    if (!overLayer || !resting || !clip || !inner || !flap || !shade || !width) return null;

    const forward = dir === 1;
    const fromRight = rtlBook ? !forward : forward;

    resting.style.zIndex = '1';
    const mode: TurnMode = settingsRef.current.turn === 'slide' ? 'slide' : 'curl';
    const el: TurnElements = { overLayer, clip, inner, flap, shade };
    prepareTurn(el, fromRight, mode);
    setTurnProgress(el, 0, width, fromRight, mode);

    return {
      el,
      mode,
      width,
      fromRight,
      // Both directions run 0 → 1; the side the fold sweeps from is what differs
      from: 0,
      to: 1,
      /** Land the turn: the uncovered page becomes the page being read. */
      settle: () => {
        clearTurn(el);
        resting.style.zIndex = '';
        frontIdxRef.current = other;
        layerRefs[other].current!.style.zIndex = '2';
        layerRefs[1 - other].current!.style.zIndex = '1';
        turningRef.current = false;
        // Warm the next page while the reader is idle
        prestageNext(targetGroup);
      },
      /** Abandon the turn and leave the reader where it was. */
      revert: () => {
        clearTurn(el);
        resting.style.zIndex = '';
        turningRef.current = false;
      },
    };
  }, [placeLayer, prestageNext, layerRefs, clipRefs, innerRefs]);

  const goToGroup = useCallback((g: number, dir: 1 | -1) => {
    const reduceMotion =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      settingsRef.current.turn === 'none';
    curlRunRef.current?.cancel();
    liveTurnRef.current?.settle();
    liveTurnRef.current = null;

    if (reduceMotion) {
      setGroup(g);
      applyGroup(g);
      scheduleSave();
      return;
    }

    const turn = beginTurn(g, dir);
    if (!turn) {
      setGroup(g);
      applyGroup(g);
      scheduleSave();
      return;
    }
    turningRef.current = true;
    setGroup(g);
    liveTurnRef.current = turn;
    curlRunRef.current = runTurn(turn.el, turn.from, turn.to, turn.width, TURN_MS, turn.fromRight, turn.mode, () => {
      liveTurnRef.current = null;
      turn.settle();
    });
    scheduleSave();
  }, [applyGroup, beginTurn, scheduleSave]);

  const next = useCallback(() => {
    const lay = layoutRef.current;
    const ep = epubRef.current;
    if (!lay || !ep || loadingChapterRef.current) return;
    if (groupRef.current < lay.groups - 1) {
      goToGroup(groupRef.current + 1, 1);
    } else if (spineRef.current < ep.spine.length - 1) {
      navDirRef.current = 1;
      pendingTarget.current = { fraction: 0 };
      setSpineIndex(spineRef.current + 1);
      scheduleSave();
    }
  }, [goToGroup, scheduleSave]);

  const prev = useCallback(() => {
    const ep = epubRef.current;
    if (loadingChapterRef.current) return;
    if (groupRef.current > 0) {
      goToGroup(groupRef.current - 1, -1);
    } else if (ep && spineRef.current > 0) {
      navDirRef.current = -1;
      pendingTarget.current = { end: true };
      setSpineIndex(spineRef.current - 1);
      scheduleSave();
    }
  }, [goToGroup, scheduleSave]);

  const jumpToHref = useCallback((href: string) => {
    const ep = epubRef.current;
    if (!ep) return;
    const { spineIndex: target, hash } = ep.hrefToSpine(href);
    if (target === -1) return;
    navDirRef.current = target >= spineRef.current ? 1 : -1;
    if (target === spineRef.current) {
      pendingTarget.current = { hash };
      measureAndPlace();
      scheduleSave();
    } else {
      pendingTarget.current = { hash };
      setSpineIndex(target);
      scheduleSave();
    }
  }, [measureAndPlace, scheduleSave]);

  const seek = useCallback((fraction: number) => {
    const ep = epubRef.current;
    if (!ep) return;
    const targetBytes = fraction * ep.totalBytes;
    let idx = 0;
    for (let i = 0; i < ep.spine.length; i++) {
      if (ep.bytesBefore[i] <= targetBytes) idx = i;
      else break;
    }
    const inner = ep.spine[idx].bytes > 0 ? (targetBytes - ep.bytesBefore[idx]) / ep.spine[idx].bytes : 0;
    navDirRef.current = idx >= spineRef.current ? 1 : -1;
    if (idx === spineRef.current) {
      pendingTarget.current = { fraction: inner };
      measureAndPlace();
    } else {
      pendingTarget.current = { fraction: inner };
      setSpineIndex(idx);
    }
    scheduleSave();
  }, [measureAndPlace, scheduleSave]);

  const nextRef = useRef(next); nextRef.current = next;
  const prevRef = useRef(prev); prevRef.current = prev;
  const jumpRef = useRef(jumpToHref); jumpRef.current = jumpToHref;

  // ---------- iframe wiring ----------
  /**
   * Touch turns follow the finger: the page tracks the drag, then springs to
   * completion or falls back depending on distance and flick speed.
   */
  const dragRef = useRef<{
    x0: number; y0: number; t0: number;
    axis: 'undecided' | 'horizontal' | 'vertical';
    turn: ReturnType<typeof beginTurn> | null;
    dir: 1 | -1;
  } | null>(null);

  const wireFrameInput = useCallback((doc: Document) => {
    doc.addEventListener('click', (e) => {
      const anchor = (e.target as Element | null)?.closest?.('a[data-quire-href]');
      if (anchor) {
        e.preventDefault();
        jumpRef.current(anchor.getAttribute('data-quire-href')!);
        return;
      }
      if ((doc.getSelection()?.toString() ?? '').length > 0) return;
      const isRtl = epubRef.current?.pageProgression === 'rtl';
      const x = (e as MouseEvent).clientX;
      const w = doc.documentElement.clientWidth;
      if (x < w * 0.22) (isRtl ? nextRef : prevRef).current();
      else if (x > w * 0.78) (isRtl ? prevRef : nextRef).current();
      else window.dispatchEvent(new Event('quire:toggle-chrome'));
    });

    let wheelLock = 0;
    doc.addEventListener('wheel', (e) => {
      const now = Date.now();
      if (now - wheelLock < 450) return;
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (Math.abs(delta) < 12) return;
      wheelLock = now;
      if (delta > 0) nextRef.current();
      else prevRef.current();
    }, { passive: true });

    doc.addEventListener('touchstart', (e) => {
      if (turningRef.current) return;
      dragRef.current = {
        x0: e.touches[0].clientX,
        y0: e.touches[0].clientY,
        t0: performance.now(),
        axis: 'undecided',
        turn: null,
        dir: 1,
      };
    }, { passive: true });

    doc.addEventListener('touchmove', (e) => {
      const d = dragRef.current;
      const lay = layoutRef.current;
      const ep = epubRef.current;
      if (!d || !lay || !ep) return;
      const dx = e.touches[0].clientX - d.x0;
      const dy = e.touches[0].clientY - d.y0;

      if (d.axis === 'undecided') {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        d.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'horizontal' : 'vertical';
        if (d.axis === 'vertical') return;

        const isRtl = ep.pageProgression === 'rtl';
        // Swiping left goes forward in LTR books, backward in RTL ones
        const forward = isRtl ? dx > 0 : dx < 0;
        d.dir = forward ? 1 : -1;
        const target = forward ? groupRef.current + 1 : groupRef.current - 1;
        // Chapter-boundary turns fall back to the normal path on release
        if (target < 0 || target > lay.groups - 1) return;
        curlRunRef.current?.cancel();
        liveTurnRef.current?.settle();
        liveTurnRef.current = null;
        turningRef.current = true;
        d.turn = beginTurn(target, d.dir);
      }

      if (d.axis !== 'horizontal' || !d.turn) return;
      const w = doc.documentElement.clientWidth || 1;
      const travelled = Math.min(1, Math.abs(dx) / (w * 0.72));
      setTurnProgress(d.turn.el, travelled, d.turn.width, d.turn.fromRight, d.turn.mode);
    }, { passive: true });

    const endDrag = (e: TouchEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;

      const dx = e.changedTouches[0].clientX - d.x0;
      const dy = e.changedTouches[0].clientY - d.y0;

      if (!d.turn) {
        // No live curl (chapter boundary or a short flick): use the plain path
        if (d.axis === 'horizontal' && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          const isRtl = epubRef.current?.pageProgression === 'rtl';
          if (dx < 0) (isRtl ? prevRef : nextRef).current();
          else (isRtl ? nextRef : prevRef).current();
        }
        turningRef.current = false;
        return;
      }

      const w = doc.documentElement.clientWidth || 1;
      const travelled = Math.min(1, Math.abs(dx) / (w * 0.72));
      const velocity = Math.abs(dx) / Math.max(1, performance.now() - d.t0); // px/ms
      const commit = travelled > 0.35 || velocity > 0.45;
      const current = travelled;
      const end = commit ? 1 : 0;
      const remaining = Math.max(120, TURN_MS * Math.abs(end - current));

      liveTurnRef.current = commit ? d.turn : { settle: d.turn.revert };
      curlRunRef.current = runTurn(d.turn.el, current, end, d.turn.width, remaining, d.turn.fromRight, d.turn.mode, () => {
        liveTurnRef.current = null;
        if (commit) {
          d.turn!.settle();
          setGroup(groupRef.current + d.dir);
          scheduleSave();
        } else {
          d.turn!.revert();
        }
      });
    };
    doc.addEventListener('touchend', endDrag, { passive: true });
    doc.addEventListener('touchcancel', endDrag, { passive: true });

    doc.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') {
        // Keyboard focus lives in the iframe after a center tap; forward Esc
        // to the parent so ReaderShell's panel/focus-mode logic runs.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return;
      }
      handleKey(ke, nextRef.current, prevRef.current, epubRef.current?.pageProgression === 'rtl');
    });

    // Any native fragment scroll would shear the column grid — pin it to 0.
    doc.addEventListener('scroll', () => {
      if (doc.documentElement.scrollLeft || doc.body.scrollLeft || doc.documentElement.scrollTop || doc.body.scrollTop) {
        doc.documentElement.scrollLeft = 0;
        doc.body.scrollLeft = 0;
        doc.documentElement.scrollTop = 0;
        doc.body.scrollTop = 0;
      }
    }, { passive: true });
  }, [beginTurn, scheduleSave]);

  /**
   * Both layers render the same chapter, so both need input wiring — either
   * can be the visible page after a turn. Measurement happens once, from the
   * layer that is currently in front.
   */
  const onFrameLoad = useCallback((layerIdx: number) => {
    const iframe = frameRefs[layerIdx].current;
    const doc = iframe?.contentDocument;
    if (!doc) return;

    if (layerIdx !== frontIdxRef.current) {
      // Back layer: park it on the current page so it is ready to be revealed
      placeLayer(layerIdx, groupRef.current);
      wireFrameInput(doc);
      return;
    }

    measureAndPlace();

    // Re-measure once fonts and images have settled (keeps the same group)
    const remeasure = () => {
      const lay = layoutRef.current;
      if (!lay) return;
      const t = lay.totalColumns <= lay.cols ? 0 : (groupRef.current * lay.cols) / lay.totalColumns;
      pendingTarget.current = { fraction: t };
      measureAndPlace();
    };
    doc.fonts?.ready?.then(() => remeasure()).catch(() => {});
    doc.querySelectorAll('img').forEach((img) => {
      if (!img.complete) img.addEventListener('load', remeasure, { once: true });
    });

    // Any native fragment scroll would shear the column grid — pin it to 0.
    const pinScroll = () => {
      if (doc.documentElement.scrollLeft || doc.body.scrollLeft || doc.documentElement.scrollTop || doc.body.scrollTop) {
        doc.documentElement.scrollLeft = 0;
        doc.body.scrollLeft = 0;
        doc.documentElement.scrollTop = 0;
        doc.body.scrollTop = 0;
      }
    };
    doc.addEventListener('scroll', pinScroll, { passive: true });

    wireFrameInput(doc);
  }, [measureAndPlace, placeLayer, frameRefs, wireFrameInput]);

  // Parent-level keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e, nextRef.current, prevRef.current, epubRef.current?.pageProgression === 'rtl');
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Flush progress when leaving
  useEffect(() => {
    const flush = () => {
      if (lastSaved.current) {
        api.saveProgress(bookMeta.id, lastSaved.current.percent, lastSaved.current.location).catch(() => {});
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [bookMeta.id]);

  // ---------- derived UI ----------
  const percent = useMemo(() => {
    if (!epub || !layout) return bookMeta.progress?.percent ?? 0;
    const fraction = layout.totalColumns <= layout.cols ? 0 : (group * layout.cols) / layout.totalColumns;
    return epub.progressFor(spineIndex, fraction);
  }, [epub, layout, group, spineIndex, bookMeta.progress]);

  // Anchor-aware "where am I": sub-sections within a chapter file count too
  const activeTocIdx = useMemo(() => {
    if (!epub) return -1;
    let idx = -1;
    epub.toc.forEach((entry, i) => {
      if (entry.spineIndex === -1) return;
      if (entry.spineIndex < spineIndex) idx = i;
      else if (entry.spineIndex === spineIndex && (anchorGroupsRef.current.get(i) ?? 0) <= group) idx = i;
    });
    return idx;
    // `layout` re-triggers after each measure so anchor groups are fresh
  }, [epub, spineIndex, group, layout]);

  const contextLabel = useMemo(
    () => (epub && activeTocIdx >= 0 ? epub.toc[activeTocIdx].label : null),
    [epub, activeTocIdx]
  );

  const toc: ShellTocEntry[] = useMemo(() => {
    if (!epub) return [];
    return epub.toc.map((entry, i) => ({
      label: entry.label,
      depth: entry.depth,
      active: i === activeTocIdx,
      onSelect: () => jumpToHref(entry.href),
    }));
  }, [epub, activeTocIdx, jumpToHref]);

  const atStart = spineIndex === 0 && group === 0;
  const atEnd = !!epub && spineIndex === epub.spine.length - 1 && !!layout && group >= layout.groups - 1;
  // Edge chevrons are spatial controls — mirror them for RTL books
  const rtl = epub?.pageProgression === 'rtl';

  if (error) {
    return (
      <div className="reader-error">
        <h2>Couldn’t open this book</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <ReaderShell
      bookTitle={bookMeta.title}
      contextLabel={contextLabel}
      positionLabel={layout ? `Page ${group + 1} of ${layout.groups} in chapter` : null}
      percent={percent}
      onSeek={epub ? seek : undefined}
      onPrev={rtl ? next : prev}
      onNext={rtl ? prev : next}
      atStart={rtl ? atEnd : atStart}
      atEnd={rtl ? atStart : atEnd}
      toc={toc}
      stageBackground={theme.stage}
      chromeDark={settings.theme === 'dusk'}
      themeVars={theme.vars}
      settingsPanel={
        <EpubSettingsPanel settings={settings} update={updateSettings} />
      }
    >
      <div className="epub-stage" ref={stageRef} style={{ background: theme.bg }}>
        {!epub && <div className="reader-loading"><BookLoader /></div>}
        {epub && srcdoc && (
          <div
            key={`${spineIndex}-${settings.spread}`}
            className={`epub-frame-wrap ${chapterVisible ? 'is-visible' : ''}`}
          >
            {[0, 1].map((i) => (
              <div
                key={i}
                className="page-layer"
                ref={layerRefs[i]}
                style={{ zIndex: i === 0 ? 2 : 1 }}
                // Only the visible page belongs to the accessibility tree
                aria-hidden={i === 1 ? true : undefined}
              >
                {/* The clip window sweeps; the content inside is counter-
                    translated by the same amount, so the text never moves. */}
                <div className="page-clip" ref={clipRefs[i]} style={{ background: theme.bg }}>
                  <div className="page-inner" ref={innerRefs[i]}>
                    <iframe
                      ref={frameRefs[i]}
                      title={i === 0 ? bookMeta.title : ''}
                      sandbox="allow-same-origin"
                      srcDoc={srcdoc}
                      onLoad={() => onFrameLoad(i)}
                      tabIndex={i === 1 ? -1 : undefined}
                    />
                  </div>
                </div>
              </div>
            ))}
            {/* Shadow the fold casts onto the page it is uncovering */}
            <div className="turn-shade" ref={shadeRef} aria-hidden />
            {/* The turned-over paper, lying on what is still flat */}
            <div className="turn-flap" ref={flapRef} style={{ backgroundColor: theme.bg }} aria-hidden />
          </div>
        )}
        {geometry && (
          <>
            {/* The column strip slides beneath the page margins — mask them
                with the same paper so neighbouring columns never peek. */}
            <div className="page-mask" style={{ left: 0, width: geometry.padLeft - 10, background: theme.bg }} aria-hidden />
            <div className="page-mask" style={{ right: 0, width: geometry.padRight - 10, background: theme.bg }} aria-hidden />
          </>
        )}
      </div>
    </ReaderShell>
  );
}

function handleKey(e: KeyboardEvent, next: () => void, prev: () => void, rtl = false) {
  if (e.defaultPrevented) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // A TOC/settings panel owns the keyboard while it's open
  if (document.documentElement.dataset.quirePanel === 'open') return;
  switch (e.key) {
    case 'ArrowRight': // spatial: mirrored for right-to-left books
      e.preventDefault();
      (rtl ? prev : next)();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      (rtl ? next : prev)();
      break;
    case 'PageDown': // logical: always forward
    case ' ':
      e.preventDefault();
      next();
      break;
    case 'PageUp':
      e.preventDefault();
      prev();
      break;
  }
}

function useStageSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Set synchronously from the observer (rounding guards against subpixel
    // re-render loops). Deferring through requestAnimationFrame would leave
    // the reader blank in a backgrounded tab, where rAF never fires.
    const update = (w: number, h: number) => {
      setSize((prev) => {
        const rw = Math.round(w);
        const rh = Math.round(h);
        if (prev && prev.w === rw && prev.h === rh) return prev;
        return rw > 0 && rh > 0 ? { w: rw, h: rh } : prev;
      });
    };
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      update(r.width, r.height);
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    update(rect.width, rect.height);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function BookLoader() {
  return (
    <div className="book-loader" role="status" aria-label="Opening book">
      <span /><span /><span />
    </div>
  );
}

function EpubSettingsPanel({
  settings, update,
}: {
  settings: ReturnType<typeof useReaderSettings>[0];
  update: (p: Partial<ReturnType<typeof useReaderSettings>[0]>) => void;
}) {
  return (
    <div className="settings-panel">
      <div className="settings-row">
        <span className="settings-label">Theme</span>
        <div className="theme-swatches">
          {(Object.keys(READER_THEMES) as ReaderTheme[]).map((t) => (
            <button
              key={t}
              className={`theme-swatch ${settings.theme === t ? 'swatch-active' : ''}`}
              style={{ background: READER_THEMES[t].bg, color: READER_THEMES[t].text }}
              onClick={() => update({ theme: t })}
              aria-label={`${READER_THEMES[t].label} theme`}
            >
              Aa
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Font</span>
        <div className="seg-row">
          {([['literata', 'Literata'], ['georgia', 'Georgia'], ['sans', 'Sans']] as [ReaderFont, string][]).map(([f, label]) => (
            <button
              key={f}
              className={`seg ${settings.font === f ? 'seg-active' : ''}`}
              style={{ fontFamily: FONT_STACKS[f] }}
              onClick={() => update({ font: f })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Size</span>
        <div className="stepper">
          <button onClick={() => update({ fontSize: clamp(settings.fontSize - 1, 14, 30) })} aria-label="Smaller text">A−</button>
          <span>{settings.fontSize}px</span>
          <button onClick={() => update({ fontSize: clamp(settings.fontSize + 1, 14, 30) })} aria-label="Larger text">A+</button>
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Spacing</span>
        <div className="stepper">
          <button onClick={() => update({ lineHeight: clamp(Number((settings.lineHeight - 0.1).toFixed(2)), 1.2, 2.2) })} aria-label="Tighter lines">−</button>
          <span>{settings.lineHeight.toFixed(1)}</span>
          <button onClick={() => update({ lineHeight: clamp(Number((settings.lineHeight + 0.1).toFixed(2)), 1.2, 2.2) })} aria-label="Looser lines">+</button>
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Layout</span>
        <div className="seg-row">
          {([['auto', 'Auto'], ['single', 'One page'], ['double', 'Two pages']] as const).map(([mode, label]) => (
            <button
              key={mode}
              className={`seg ${settings.spread === mode ? 'seg-active' : ''}`}
              onClick={() => update({ spread: mode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Page turn</span>
        <div className="seg-row">
          {([['curl', 'Curl'], ['slide', 'Slide'], ['none', 'None']] as const).map(([mode, label]) => (
            <button
              key={mode}
              className={`seg ${settings.turn === mode ? 'seg-active' : ''}`}
              onClick={() => update({ turn: mode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Style</span>
        <div className="seg-row">
          <button className={`seg ${!settings.pubStyles ? 'seg-active' : ''}`} onClick={() => update({ pubStyles: false })}>Quire</button>
          <button className={`seg ${settings.pubStyles ? 'seg-active' : ''}`} onClick={() => update({ pubStyles: true })}>Original</button>
        </div>
      </div>
    </div>
  );
}
