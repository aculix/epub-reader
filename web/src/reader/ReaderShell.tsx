import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router-dom';
import { IconArrowLeft, IconChevronLeft, IconChevronRight, IconClose, IconContents, IconType } from '../components/Icons';

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
}

const IDLE_HIDE_MS = 3800;

export default function ReaderShell({
  bookTitle, contextLabel, positionLabel, percent, onSeek,
  onPrev, onNext, atStart, atEnd, toc, settingsPanel, children,
  stageBackground, chromeDark,
}: Props) {
  const [chromeVisible, setChromeVisible] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anyPanelOpen = tocOpen || settingsOpen;
  const anyPanelOpenRef = useRef(anyPanelOpen);
  anyPanelOpenRef.current = anyPanelOpen;

  const poke = useCallback(() => {
    setChromeVisible(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (!anyPanelOpenRef.current) setChromeVisible(false);
    }, IDLE_HIDE_MS);
  }, []);

  useEffect(() => {
    poke();
    return () => clearTimeout(idleTimer.current);
  }, [poke]);

  // Toggling chrome from the stage (center tap) is exposed via a custom event
  useEffect(() => {
    const onToggle = () => {
      setChromeVisible((v) => {
        if (v) {
          clearTimeout(idleTimer.current);
          return false;
        }
        poke();
        return true;
      });
    };
    const onPoke = () => poke();
    window.addEventListener('quire:toggle-chrome', onToggle);
    window.addEventListener('quire:poke-chrome', onPoke);
    return () => {
      window.removeEventListener('quire:toggle-chrome', onToggle);
      window.removeEventListener('quire:poke-chrome', onPoke);
    };
  }, [poke]);

  const closePanels = () => { setTocOpen(false); setSettingsOpen(false); };

  return (
    <div
      className={`reader ${chromeDark ? 'reader-chrome-dark' : ''} ${chromeVisible ? 'chrome-on' : 'chrome-off'}`}
      style={{ background: stageBackground, '--reader-bg': stageBackground } as React.CSSProperties}
      onMouseMove={poke}
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

      {/* top chrome */}
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
            onClick={() => { setSettingsOpen(false); setTocOpen((v) => !v); poke(); }}
          >
            <IconContents />
          </button>
          <button
            className={`icon-btn ${settingsOpen ? 'icon-btn-active' : ''}`}
            aria-label="Display settings"
            onClick={() => { setTocOpen(false); setSettingsOpen((v) => !v); poke(); }}
          >
            <IconType />
          </button>
        </div>
      </header>

      {/* bottom chrome */}
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
              <div className="toc-list">
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
