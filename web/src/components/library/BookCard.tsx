import { useState } from 'react';
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
  const percent = book.progress?.percent ?? 0;

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
          <div className="book-cover-sheen" />
          <span className={`format-chip format-${book.format}`}>{book.format === 'epub' ? 'ePUB' : 'PDF'}</span>
          {percent > 0 && percent < 1 && (
            <div className="cover-progress">
              <div className="cover-progress-fill" style={{ width: `${Math.round(percent * 100)}%` }} />
            </div>
          )}
          {percent >= 1 && <span className="finished-chip">Finished</span>}
        </div>
      </Link>

      <div className="book-meta">
        <div className="book-text">
          <Link to={`/read/${book.id}`} className="book-title" title={book.title}>{book.title}</Link>
          {book.author && <span className="book-author" title={book.author}>{book.author}</span>}
        </div>
        <div className={`book-menu ${menuOpen ? 'open' : ''}`}>
          <button
            className="icon-btn book-menu-btn"
            aria-label={`Options for ${book.title}`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
          >
            <IconDots />
          </button>
          {menuOpen && (
            <motion.div
              className="menu-pop"
              initial={{ opacity: 0, y: 6, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <button onMouseDown={() => onDetails(book)}><IconInfo /> About this book</button>
              <button onMouseDown={() => onRefresh(book)}><IconRefresh /> Refresh metadata</button>
              <button className="danger" onMouseDown={() => onDelete(book)}><IconTrash /> Remove</button>
            </motion.div>
          )}
        </div>
      </div>
    </motion.article>
  );
}
