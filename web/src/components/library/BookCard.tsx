import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import type { Book } from '../../lib/api';
import { IconDots, IconInfo, IconRefresh, IconTrash, IconBook } from '../Icons';

interface Props {
  book: Book;
  index: number;
  onDetails: (book: Book) => void;
  onRefresh: (book: Book) => void;
  onDelete: (book: Book) => void;
}

/** Deterministic warm hue per book for cover placeholders. */
function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function CoverImage({ book, sizes }: { book: Book; sizes?: string }) {
  const [failed, setFailed] = useState(false);
  if (book.coverUrl && !failed) {
    return (
      <img
        src={book.coverUrl}
        alt=""
        loading="lazy"
        sizes={sizes}
        onError={() => setFailed(true)}
        draggable={false}
      />
    );
  }
  const hue = hueFor(book.id);
  return (
    <div
      className="cover-placeholder"
      style={{ background: `linear-gradient(160deg, hsl(${hue} 32% 30%), hsl(${(hue + 40) % 360} 38% 18%))` }}
    >
      <IconBook />
      <span>{book.title}</span>
    </div>
  );
}

export default function BookCard({ book, index, onDetails, onRefresh, onDelete }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const percent = book.progress?.percent ?? 0;

  /**
   * Return focus to the menu button before opening a dialog: the menu item
   * that was clicked unmounts with the menu, and a dialog opening from a
   * detached element has no trigger left to restore focus to.
   */
  const runFromMenu = (action: () => void) => {
    menuBtnRef.current?.focus();
    setMenuOpen(false);
    action();
  };

  return (
    <motion.article
      className="book-card"
      layout
      initial={{ opacity: 0, y: 26, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.5, delay: Math.min(index * 0.045, 0.5), ease: [0.22, 1, 0.36, 1] }}
    >
      <Link to={`/read/${book.id}`} className="book-cover-link" aria-label={`Read ${book.title}`}>
        <div className="book-cover">
          <CoverImage book={book} />
        </div>
      </Link>

      {percent > 0 && percent < 1 && (
        <div
          className="book-progress"
          role="progressbar"
          aria-valuenow={Math.round(percent * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${Math.round(percent * 100)}% read`}
        >
          <div className="book-progress-fill" style={{ width: `${Math.round(percent * 100)}%` }} />
        </div>
      )}

      <div className="book-meta">
        <div className="book-text">
          <Link to={`/read/${book.id}`} className="book-title" title={book.title}>{book.title}</Link>
          {book.author && <span className="book-author" title={book.author}>{book.author}</span>}
          <span className="book-caption">
            {book.format === 'epub' ? 'ePUB' : 'PDF'}
            {percent >= 1 && <em className="book-finished"> · Finished</em>}
          </span>
        </div>
        <div
          className={`book-menu ${menuOpen ? 'open' : ''}`}
          onBlur={(e) => {
            // Close only when focus truly leaves the menu (keyboard-safe)
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenuOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setMenuOpen(false);
          }}
        >
          <button
            ref={menuBtnRef}
            className="icon-btn book-menu-btn"
            aria-label={`Options for ${book.title}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconDots />
          </button>
          {menuOpen && (
            <motion.div
              className="menu-pop"
              aria-label={`Options for ${book.title}`}
              initial={{ opacity: 0, y: 6, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <button onClick={() => runFromMenu(() => onDetails(book))}><IconInfo /> About this book</button>
              <button onClick={() => runFromMenu(() => onRefresh(book))}><IconRefresh /> Refresh metadata</button>
              <button className="danger" onClick={() => runFromMenu(() => onDelete(book))}><IconTrash /> Remove</button>
            </motion.div>
          )}
        </div>
      </div>
    </motion.article>
  );
}
