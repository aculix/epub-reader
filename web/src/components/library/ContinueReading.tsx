import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import type { Book } from '../../lib/api';
import { CoverImage } from './BookCard';

export default function ContinueReading({ book }: { book: Book }) {
  const percent = Math.round((book.progress?.percent ?? 0) * 100);
  return (
    <motion.section
      className="continue-strip"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Continue reading"
    >
      <Link to={`/read/${book.id}`} className="continue-card">
        <div className="continue-cover">
          <CoverImage book={book} />
        </div>
        <div className="continue-info">
          <span className="continue-kicker">Continue reading</span>
          <h2 className="continue-title">{book.title}</h2>
          {book.author && <p className="continue-author">{book.author}</p>}
          <div className="continue-progress">
            <div className="continue-progress-track">
              <motion.div
                className="continue-progress-fill"
                initial={{ width: 0 }}
                animate={{ width: `${percent}%` }}
                transition={{ duration: 0.9, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            <span className="continue-percent">{percent}%</span>
          </div>
        </div>
        <span className="continue-resume btn btn-primary">Resume</span>
      </Link>
    </motion.section>
  );
}
