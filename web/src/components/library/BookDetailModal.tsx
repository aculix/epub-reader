import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import type { Book } from '../../lib/api';
import { formatBytes, formatYear } from '../../lib/format';
import { CoverImage } from './BookCard';
import { IconClose, IconRefresh, IconTrash } from '../Icons';

interface Props {
  book: Book;
  onClose: () => void;
  onRefresh: (book: Book) => Promise<void>;
  onDelete: (book: Book) => void;
}

export default function BookDetailModal({ book, onClose, onRefresh, onDelete }: Props) {
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const facts: Array<[string, string | null]> = [
    ['Published', formatYear(book.publishedDate)],
    ['Publisher', book.publisher],
    ['Pages', book.pageCount ? String(book.pageCount) : null],
    ['Language', book.language?.toUpperCase() ?? null],
    ['ISBN', book.isbn],
    ['File', `${book.format.toUpperCase()} · ${formatBytes(book.fileSize)}`],
  ];

  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onClose}
    >
      <motion.div
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`About ${book.title}`}
        initial={{ opacity: 0, y: 40, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>

        <div className="detail-cover-col">
          <div className="detail-cover">
            <CoverImage book={book} />
          </div>
          <Link to={`/read/${book.id}`} className="btn btn-primary detail-read-btn">
            {book.progress && book.progress.percent > 0 && book.progress.percent < 1
              ? `Resume · ${Math.round(book.progress.percent * 100)}%`
              : 'Read'}
          </Link>
        </div>

        <div className="detail-body">
          <p className="detail-kicker">{book.categories.length ? book.categories.join(' · ') : 'In your library'}</p>
          <h2>{book.title}</h2>
          {book.author && <p className="detail-author">by {book.author}</p>}

          {book.description ? (
            <div className="detail-description">{book.description.replace(/<[^>]+>/g, ' ')}</div>
          ) : (
            <p className="detail-description detail-description-empty">
              No description found for this book yet. Try “Refresh metadata” to search again.
            </p>
          )}

          <dl className="detail-facts">
            {facts.filter(([, v]) => v).map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>

          <div className="detail-actions">
            <button
              className="btn btn-ghost"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try { await onRefresh(book); } finally { setRefreshing(false); }
              }}
            >
              <IconRefresh className={refreshing ? 'spin' : undefined} />
              {refreshing ? 'Searching…' : 'Refresh metadata'}
            </button>
            <button className="btn btn-ghost btn-danger" onClick={() => onDelete(book)}>
              <IconTrash /> Remove from library
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
