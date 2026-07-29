import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, type Book, type EpubLocation } from '../lib/api';
import { EpubBook } from './loadEpub';
import ReaderShell, { type ShellTocEntry } from '../reader/ReaderShell';
import { READER_THEMES, useReaderSettings, type ReaderFont, type ReaderTheme } from '../reader/readerSettings';
import { clamp } from '../lib/format';

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
  const [turnFx, setTurnFx] = useState<{ id: number; dir: 1 | -1 } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const groupRef = useRef(0);
  const spineRef = useRef(0);
  const epubRef = useRef<EpubBook | null>(null);
  const navDirRef = useRef<1 | -1>(1);
  const turnCounter = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSaved = useRef<{ percent: number; location: EpubLocation } | null>(null);
  // Where to land once the incoming chapter is measured
  const pendingTarget = useRef<{ fraction?: number; hash?: string; end?: boolean }>({ fraction: 0 });
  // Blocks next/prev while a chapter is loading, so holding an arrow key at a
  // boundary can't act on stale group/layout refs and skip chapters.
  const loadingChapterRef = useRef(false);

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
        transition: transform ${TURN_MS}ms cubic-bezier(0.22, 1, 0.36, 1);
        will-change: transform;
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
  const applyGroup = useCallback((g: number, animate: boolean) => {
    const doc = iframeRef.current?.contentDocument;
    const root = doc?.getElementById('quire-root');
    const lay = layoutRef.current;
    if (!root || !lay) return;
    const sign = epubRef.current?.pageProgression === 'rtl' ? 1 : -1;
    root.style.transition = animate ? `transform ${TURN_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : 'none';
    root.style.transform = `translateX(${sign * g * lay.stepW}px)`;
    if (!animate) {
      // force reflow so the next transition animates from here
      void root.getBoundingClientRect();
      root.style.transition = `transform ${TURN_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    }
  }, []);

  const measureAndPlace = useCallback(() => {
    const iframe = iframeRef.current;
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

    // Resolve the pending target into a page group
    const t = pendingTarget.current;
    const rtl = epubRef.current?.pageProgression === 'rtl';
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
    applyGroup(g, false);
    setChapterVisible(true);
    loadingChapterRef.current = false;
  }, [stageSize, settings.spread, applyGroup]);

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

  const goToGroup = useCallback((g: number, dir: 1 | -1) => {
    setGroup(g);
    applyGroup(g, true);
    setTurnFx({ id: ++turnCounter.current, dir });
    scheduleSave();
  }, [applyGroup, scheduleSave]);

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
  const onIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc) return;

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

    // Input inside the sandboxed document
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

    let touchX = 0, touchY = 0;
    doc.addEventListener('touchstart', (e) => {
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    }, { passive: true });
    doc.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        const isRtl = epubRef.current?.pageProgression === 'rtl';
        if (dx < 0) (isRtl ? prevRef : nextRef).current();
        else (isRtl ? nextRef : prevRef).current();
      }
    }, { passive: true });

    doc.addEventListener('keydown', (e) => handleKey(e as KeyboardEvent, nextRef.current, prevRef.current, epubRef.current?.pageProgression === 'rtl'));
  }, [measureAndPlace]);

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

  const contextLabel = useMemo(() => {
    if (!epub) return null;
    let label: string | null = null;
    for (const entry of epub.toc) {
      if (entry.spineIndex !== -1 && entry.spineIndex <= spineIndex) label = entry.label;
      if (entry.spineIndex > spineIndex) break;
    }
    return label;
  }, [epub, spineIndex]);

  const toc: ShellTocEntry[] = useMemo(() => {
    if (!epub) return [];
    let activeIdx = -1;
    epub.toc.forEach((entry, i) => {
      if (entry.spineIndex !== -1 && entry.spineIndex <= spineIndex) activeIdx = i;
    });
    return epub.toc.map((entry, i) => ({
      label: entry.label,
      depth: entry.depth,
      active: i === activeIdx,
      onSelect: () => jumpToHref(entry.href),
    }));
  }, [epub, spineIndex, jumpToHref]);

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
          <motion.div
            key={`${spineIndex}-${settings.spread}`}
            className="epub-frame-wrap"
            initial={{ opacity: 0, x: navDirRef.current * 26 }}
            animate={{ opacity: chapterVisible ? 1 : 0, x: chapterVisible ? 0 : navDirRef.current * 26 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <iframe
              ref={iframeRef}
              title={bookMeta.title}
              sandbox="allow-same-origin"
              srcDoc={srcdoc}
              onLoad={onIframeLoad}
            />
          </motion.div>
        )}
        {geometry && (
          <>
            {/* The column strip slides beneath the page margins — mask them
                with the same paper so neighbouring columns never peek. */}
            <div className="page-mask" style={{ left: 0, width: geometry.padLeft - 10, background: theme.bg }} aria-hidden />
            <div className="page-mask" style={{ right: 0, width: geometry.padRight - 10, background: theme.bg }} aria-hidden />
          </>
        )}
        <AnimatePresence>
          {turnFx && (
            <motion.div
              key={turnFx.id}
              className="turn-shadow"
              initial={{ x: (rtl ? -turnFx.dir : turnFx.dir) === 1 ? '110%' : '-40%', opacity: 0.9 }}
              animate={{ x: (rtl ? -turnFx.dir : turnFx.dir) === 1 ? '-40%' : '110%', opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: TURN_MS / 1000 + 0.1, ease: [0.3, 0.6, 0.3, 1] }}
              onAnimationComplete={() => setTurnFx(null)}
              aria-hidden
            />
          )}
        </AnimatePresence>
      </div>
    </ReaderShell>
  );
}

function handleKey(e: KeyboardEvent, next: () => void, prev: () => void, rtl = false) {
  if (e.defaultPrevented) return;
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      // Debounce via rAF; round to avoid re-render loops on subpixels
      requestAnimationFrame(() => {
        setSize((prevSize) => {
          const w = Math.round(r.width);
          const h = Math.round(r.height);
          if (prevSize && prevSize.w === w && prevSize.h === h) return prevSize;
          return w > 0 && h > 0 ? { w, h } : prevSize;
        });
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function BookLoader() {
  return (
    <div className="book-loader" aria-label="Opening book">
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
        <span className="settings-label">Style</span>
        <div className="seg-row">
          <button className={`seg ${!settings.pubStyles ? 'seg-active' : ''}`} onClick={() => update({ pubStyles: false })}>Quire</button>
          <button className={`seg ${settings.pubStyles ? 'seg-active' : ''}`} onClick={() => update({ pubStyles: true })}>Original</button>
        </div>
      </div>
    </div>
  );
}
