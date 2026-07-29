import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router-dom';
import { IconArrowLeft, IconChevronLeft, IconChevronRight, IconClose, IconContents, IconFullscreen, IconFullscreenExit, IconType } from '../components/Icons';
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar';

export interface ShellTocEntry {
  label: string;
  depth: number;
  active: boolean;
  onSelect: () => void;
}

interface Props {
  bookTitle: string;
  contextLabel?: string | null; // e.g. current chapter
  positionLabel?: string | null; // e.g. "Page 24 of 310"
  percent: number; // 0..1
  onSeek?: (fraction: number) => void;
  onPrev: () => void;
  onNext: () => void;
  atStart: boolean;
  atEnd: boolean;
  toc: ShellTocEntry[];
  settingsPanel: ReactNode;
  children: ReactNode; // the reading stage
  stageBackground: string;
  chromeDark?: boolean;
  /** Local design-token overrides so reader chrome follows the reader theme,
      independent of the app-level light/dark toggle. */
  themeVars?: Record<string, string>;
  /** True when the stage scrolls content under the bars (e.g. zoomed PDF) —
      gives the bars a gradient backdrop so they stay legible. */
  scrollsUnderChrome?: boolean;
}

/**
 * Reader chrome lives in the page's own margins — a running head up top and
 * a folio line below, on the same paper as the text. Nothing overlays or
 * fades over the content. Visibility is an explicit choice: focus mode hides
 * everything and only a deliberate center tap (or Esc) brings it back —
 * moving the mouse never pops controls open.
 */
export default function ReaderShell({
  bookTitle, contextLabel, positionLabel, percent, onSeek,
  onPrev, onNext, atStart, atEnd, toc, settingsPanel, children,
  stageBackground, chromeDark, themeVars, scrollsUnderChrome,
}: Props) {
  const [focus, setFocus] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const chromeVisible = !focus;
  const tocListRef = useAutoHideScrollbar<HTMLDivElement>();

  const closePanels = useCallback(() => {
    setTocOpen(false);
    setSettingsOpen(false);
  }, []);

  // Full screen = immersive reading: browser fullscreen + controls tucked away.
  // Center tap still shows/hides controls independently while fullscreen.
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        closePanels();
        await document.documentElement.requestFullscreen();
        setFocus(true);
      }
    } catch {
      // Fullscreen unavailable (e.g. iOS Safari) — fall back to hiding controls
      closePanels();
      setFocus(true);
    }
  }, [closePanels]);

  useEffect(() => {
    const onFsChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs) setFocus(false); // leaving fullscreen brings the controls back
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Let document-level effects (paper-grain overlay) match the reading
  // surface rather than the app theme while a book is open.
  useEffect(() => {
    document.documentElement.dataset.readerSurface = chromeDark ? 'dark' : 'light';
    return () => {
      delete document.documentElement.dataset.readerSurface;
    };
  }, [chromeDark]);

  // Center tap on the page toggles focus mode
  useEffect(() => {
    const onToggle = () => setFocus((f) => !f);
    window.addEventListener('quire:toggle-chrome', onToggle);
    return () => window.removeEventListener('quire:toggle-chrome', onToggle);
  }, []);

  // Esc: close the topmost panel first, then leave focus mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (tocOpen || settingsOpen) {
        closePanels();
      } else if (focus) {
        setFocus(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tocOpen, settingsOpen, focus, closePanels]);

  return (
    <div
      className={`reader ${chromeDark ? 'reader-chrome-dark' : ''} ${chromeVisible ? 'chrome-on' : 'chrome-off'} ${scrollsUnderChrome ? 'chrome-backdrop' : ''}`}
      style={{ background: stageBackground, '--reader-bg': stageBackground, ...themeVars } as React.CSSProperties}
    >
      <div className="reader-stage-wrap">{children}</div>

      {/* edge page-turn buttons (desktop) */}
      <button
        className="page-edge-btn edge-left"
        onClick={onPrev}
        disabled={atStart}
        aria-label="Previous page"
        tabIndex={-1}
      >
        <IconChevronLeft />
      </button>
      <button
        className="page-edge-btn edge-right"
        onClick={onNext}
        disabled={atEnd}
        aria-label="Next page"
        tabIndex={-1}
      >
        <IconChevronRight />
      </button>

      {/* running head */}
      <header className={`reader-top ${chromeVisible ? '' : 'hidden-bar'}`}>
        <div className="reader-top-left">
          <Link to="/" className="icon-btn" aria-label="Back to library"><IconArrowLeft /></Link>
          <div className="reader-titles">
            <span className="reader-book-title">{bookTitle}</span>
            {contextLabel && <span className="reader-context">{contextLabel}</span>}
          </div>
        </div>
        <div className="reader-top-right">
          <button
            className={`icon-btn ${tocOpen ? 'icon-btn-active' : ''}`}
            aria-label="Table of contents"
            onClick={() => { setSettingsOpen(false); setTocOpen((v) => !v); }}
          >
            <IconContents />
          </button>
          <button
            className={`icon-btn ${settingsOpen ? 'icon-btn-active' : ''}`}
            aria-label="Display settings"
            onClick={() => { setTocOpen(false); setSettingsOpen((v) => !v); }}
          >
            <IconType />
          </button>
          <button
            className="icon-btn"
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
            title={isFullscreen
              ? 'Exit full screen'
              : 'Full screen — immersive reading. Tap the page to show or hide controls; Esc to leave.'}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <IconFullscreenExit /> : <IconFullscreen />}
          </button>
        </div>
      </header>

      {/* folio */}
      <footer className={`reader-bottom ${chromeVisible ? '' : 'hidden-bar'}`}>
        <div className="scrubber-row">
          <input
            className="scrubber"
            type="range"
            min={0}
            max={1000}
            value={Math.round(percent * 1000)}
            aria-label="Book position"
            onChange={(e) => onSeek?.(Number(e.target.value) / 1000)}
            disabled={!onSeek}
            style={{ '--fill': `${percent * 100}%` } as React.CSSProperties}
          />
        </div>
        <div className="reader-bottom-info">
          <span className="reader-percent">{Math.round(percent * 100)}%</span>
          {positionLabel && <span className="reader-position">{positionLabel}</span>}
        </div>
      </footer>

      {/* TOC drawer */}
      <AnimatePresence>
        {tocOpen && (
          <>
            <motion.div
              className="panel-scrim"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closePanels}
            />
            <motion.aside
              className="toc-drawer"
              initial={{ x: '-104%' }}
              animate={{ x: 0 }}
              exit={{ x: '-104%' }}
              transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              role="navigation"
              aria-label="Table of contents"
            >
              <div className="toc-head">
                <h3>Contents</h3>
                <button className="icon-btn" onClick={closePanels} aria-label="Close contents"><IconClose /></button>
              </div>
              <div className="toc-list quire-scroll" ref={tocListRef}>
                {toc.map((entry, i) => (
                  <button
                    key={i}
                    className={`toc-item ${entry.active ? 'toc-active' : ''}`}
                    style={{ paddingLeft: 18 + entry.depth * 16 }}
                    onClick={() => { entry.onSelect(); closePanels(); }}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* settings popover */}
      <AnimatePresence>
        {settingsOpen && (
          <>
            <motion.div
              className="panel-scrim scrim-clear"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={closePanels}
            />
            <motion.div
              className="settings-pop"
              initial={{ opacity: 0, y: -10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              role="dialog"
              aria-label="Display settings"
            >
              {settingsPanel}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
