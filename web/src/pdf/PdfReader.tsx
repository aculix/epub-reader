import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { api, type Book, type PdfLocation } from '../lib/api';
import ReaderShell, { type ShellTocEntry } from '../reader/ReaderShell';
import { READER_THEMES } from '../reader/readerSettings';
import { clamp } from '../lib/format';
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar';
import { IconZoomIn, IconZoomOut } from '../components/Icons';

type PdfTheme = 'paper' | 'dusk';
type PdfSpread = 'auto' | 'single' | 'double';

interface PdfSettings {
  theme: PdfTheme;
  spread: PdfSpread;
  night: boolean; // invert page colors for dark-room reading
}

// Same paper tones as the ePUB reader themes — one cohesive surface.
const PDF_STAGE: Record<PdfTheme, { stage: string; chromeDark: boolean }> = {
  paper: { stage: '#f9f5ec', chromeDark: false },
  dusk: { stage: '#181512', chromeDark: true },
};

const SETTINGS_KEY = 'quire:pdf-settings';

interface OutlineItem {
  label: string;
  depth: number;
  page: number;
}

export default function PdfReader({ book: bookMeta }: { book: Book }) {
  const [settings, setSettings] = useState<PdfSettings>(() => {
    try {
      return { theme: 'paper', spread: 'auto', night: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { theme: 'paper', spread: 'auto', night: false };
    }
  });
  const update = useCallback((patch: Partial<PdfSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(() => {
    const loc = bookMeta.progress?.location;
    return loc && loc.kind === 'pdf' ? loc.page : 1;
  });
  const [dir, setDir] = useState<1 | -1>(1);
  const [zoom, setZoom] = useState(1);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [pageAspect, setPageAspect] = useState(0.7); // w/h of page 1

  const stageRef = useRef<HTMLDivElement>(null);
  const stageSize = useStageSize(stageRef);
  useAutoHideScrollbar(stageRef);
  const pageRef = useRef(page);
  pageRef.current = page;
  const docRef = useRef<PDFDocumentProxy | null>(null);
  docRef.current = doc;
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ---------- load document ----------
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const pdfjs = (await import('./pdfjs')).default;
        const task = pdfjs.getDocument({ url: api.fileUrl(bookMeta.id) });
        loaded = await task.promise;
        if (cancelled) { loaded.destroy(); return; }
        const first = await loaded.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setPageAspect(vp.width / vp.height);
        setDoc(loaded);
        setPage((p) => clamp(p, 1, loaded!.numPages));

        // Outline → page numbers (best effort)
        try {
          const raw = await loaded.getOutline();
          if (raw && !cancelled) {
            const items: OutlineItem[] = [];
            const walk = async (nodes: typeof raw, depth: number) => {
              for (const node of nodes) {
                let pageNum: number | null = null;
                try {
                  let dest = node.dest;
                  if (typeof dest === 'string') dest = await loaded!.getDestination(dest);
                  if (Array.isArray(dest) && dest[0]) {
                    pageNum = (await loaded!.getPageIndex(dest[0])) + 1;
                  }
                } catch { /* skip unresolvable */ }
                if (pageNum != null) items.push({ label: node.title || 'Untitled', depth, page: pageNum });
                if (node.items?.length) await walk(node.items, depth + 1);
              }
            };
            await walk(raw, 0);
            if (!cancelled) setOutline(items);
          }
        } catch { /* outline optional */ }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to open this PDF');
      }
    })();
    return () => {
      cancelled = true;
      loaded?.destroy();
    };
  }, [bookMeta.id]);

  // ---------- layout ----------
  const cols = useMemo(() => {
    if (settings.spread === 'single') return 1;
    if (settings.spread === 'double') return 2;
    if (!stageSize) return 1;
    return stageSize.w >= 1080 && pageAspect < 1 ? 2 : 1;
  }, [settings.spread, stageSize, pageAspect]);

  /** Pages shown for the current view; first page always stands alone in spreads. */
  const view = useMemo(() => {
    if (!doc) return [page];
    if (cols === 1) return [page];
    if (page <= 1) return [1];
    const left = page % 2 === 0 ? page : page - 1;
    return left + 1 <= doc.numPages ? [left, left + 1] : [left];
  }, [page, cols, doc]);

  // ---------- navigation ----------
  const scheduleSave = useCallback((p: number) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const d = docRef.current;
      if (!d) return;
      const location: PdfLocation = { kind: 'pdf', page: p };
      api.saveProgress(bookMeta.id, p / d.numPages, location).catch(() => {});
    }, 600);
  }, [bookMeta.id]);

  const goTo = useCallback((p: number, direction?: 1 | -1) => {
    const d = docRef.current;
    if (!d) return;
    const target = clamp(p, 1, d.numPages);
    setDir(direction ?? (target >= pageRef.current ? 1 : -1));
    setPage(target);
    scheduleSave(target);
  }, [scheduleSave]);

  const next = useCallback(() => {
    const d = docRef.current;
    if (!d) return;
    const last = view[view.length - 1];
    if (last < d.numPages) goTo(last + 1, 1);
  }, [view, goTo]);

  const prev = useCallback(() => {
    const first = view[0];
    if (first > 1) goTo(cols === 2 ? Math.max(1, first - 2) : first - 1, -1);
  }, [view, cols, goTo]);

  const nextRef = useRef(next); nextRef.current = next;
  const prevRef = useRef(prev); prevRef.current = prev;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); nextRef.current(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prevRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const wheelLock = useRef(0);
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (zoom > 1) return; // zoomed: wheel scrolls the pan container
    const now = Date.now();
    if (now - wheelLock.current < 450) return;
    if (Math.abs(e.deltaY) < 12) return;
    wheelLock.current = now;
    if (e.deltaY > 0) next(); else prev();
  }, [zoom, next, prev]);

  const touch = useRef({ x: 0, y: 0 });
  const percent = doc ? page / doc.numPages : bookMeta.progress?.percent ?? 0;

  const toc: ShellTocEntry[] = useMemo(() => {
    let activeIdx = -1;
    outline.forEach((o, i) => { if (o.page <= page) activeIdx = i; });
    return outline.map((o, i) => ({
      label: o.label,
      depth: o.depth,
      active: i === activeIdx,
      onSelect: () => goTo(o.page),
    }));
  }, [outline, page, goTo]);

  if (error) {
    return (
      <div className="reader-error">
        <h2>Couldn’t open this book</h2>
        <p>{error}</p>
      </div>
    );
  }

  const stageTheme = PDF_STAGE[settings.theme];

  return (
    <ReaderShell
      bookTitle={bookMeta.title}
      contextLabel={null}
      positionLabel={doc ? `Page ${view.join('–')} of ${doc.numPages}` : null}
      percent={percent}
      onSeek={doc ? (f) => goTo(Math.max(1, Math.round(f * doc.numPages))) : undefined}
      onPrev={prev}
      onNext={next}
      atStart={view[0] <= 1}
      atEnd={!!doc && view[view.length - 1] >= doc.numPages}
      toc={toc}
      stageBackground={stageTheme.stage}
      chromeDark={stageTheme.chromeDark}
      themeVars={READER_THEMES[settings.theme === 'dusk' ? 'dusk' : 'paper'].vars}
      scrollsUnderChrome={zoom > 1}
      settingsPanel={
        <div className="settings-panel">
          <div className="settings-row">
            <span className="settings-label">Surround</span>
            <div className="seg-row">
              <button className={`seg ${settings.theme === 'paper' ? 'seg-active' : ''}`} onClick={() => update({ theme: 'paper' })}>Paper</button>
              <button className={`seg ${settings.theme === 'dusk' ? 'seg-active' : ''}`} onClick={() => update({ theme: 'dusk' })}>Dusk</button>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">Night mode</span>
            <div className="seg-row">
              <button className={`seg ${!settings.night ? 'seg-active' : ''}`} onClick={() => update({ night: false })}>Off</button>
              <button className={`seg ${settings.night ? 'seg-active' : ''}`} onClick={() => update({ night: true })}>Invert</button>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">Layout</span>
            <div className="seg-row">
              {([['auto', 'Auto'], ['single', 'One page'], ['double', 'Two pages']] as const).map(([mode, label]) => (
                <button key={mode} className={`seg ${settings.spread === mode ? 'seg-active' : ''}`} onClick={() => update({ spread: mode })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">Zoom</span>
            <div className="stepper">
              <button onClick={() => setZoom((z) => clamp(Number((z - 0.25).toFixed(2)), 1, 3))} aria-label="Zoom out"><IconZoomOut /></button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => clamp(Number((z + 0.25).toFixed(2)), 1, 3))} aria-label="Zoom in"><IconZoomIn /></button>
            </div>
          </div>
        </div>
      }
    >
      <div
        className={`pdf-stage quire-scroll ${zoom > 1 ? 'pdf-zoomed' : ''}`}
        ref={stageRef}
        onWheel={onWheel}
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const x = (e.clientX - rect.left) / rect.width;
          if ((window.getSelection()?.toString() ?? '').length > 0) return;
          if (x < 0.18) prev();
          else if (x > 0.82) next();
          else window.dispatchEvent(new Event('quire:toggle-chrome'));
        }}
        onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchEnd={(e) => {
          if (zoom > 1) return; // zoomed: touch pans the scroll container
          const dx = e.changedTouches[0].clientX - touch.current.x;
          const dy = e.changedTouches[0].clientY - touch.current.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            if (dx < 0) next(); else prev();
          }
        }}
      >
        {!doc && <div className="reader-loading"><div className="book-loader"><span /><span /><span /></div></div>}
        {doc && stageSize && (
          <AnimatePresence initial={false}>
            <motion.div
              key={view.join('-')}
              className={`pdf-view ${settings.night ? 'pdf-night' : ''}`}
              initial={{ x: dir * 60, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: dir * -60, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              {view.map((p) => (
                <PdfPage key={p} doc={doc} pageNum={p} stageSize={stageSize} cols={cols} zoom={zoom} />
              ))}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </ReaderShell>
  );
}

function PdfPage({
  doc, pageNum, stageSize, cols, zoom,
}: {
  doc: PDFDocumentProxy;
  pageNum: number;
  stageSize: { w: number; h: number };
  cols: number;
  zoom: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
    (async () => {
      try {
        const pdfPage = await doc.getPage(pageNum);
        page = pdfPage;
        if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const availW = (stageSize.w - 64 - (cols - 1) * 20) / cols;
        // Clear the running head and folio — chrome lives in the margins now
        const availH = stageSize.h - 118;
        const fit = Math.min(availW / base.width, availH / base.height);
        const scale = fit * zoom;
        let dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        // Pixel budget: iOS Safari refuses canvases beyond ~16.7M pixels
        const MAX_PIXELS = 16_000_000;
        const cssPixels = base.width * scale * base.height * scale;
        if (cssPixels * dpr * dpr > MAX_PIXELS) {
          dpr = Math.max(1, Math.sqrt(MAX_PIXELS / cssPixels));
        }
        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext('2d')!;
        renderTaskRef.current?.cancel();
        const task = pdfPage.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTaskRef.current = task;
        await task.promise.catch(() => {});
      } catch { /* page render cancelled or failed */ }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      // Release the page's decoded images/operator list; pdf.js caches page
      // proxies for the document's lifetime otherwise. cleanup() refuses
      // internally while a render is active, so this is safe best-effort.
      try { page?.cleanup(); } catch { /* fine */ }
    };
  }, [doc, pageNum, stageSize, cols, zoom]);

  return <canvas ref={canvasRef} className="pdf-page-canvas" />;
}

function useStageSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
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
