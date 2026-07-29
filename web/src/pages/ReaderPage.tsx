import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type Book } from '../lib/api';
import '../styles/reader.css';

const EpubReader = lazy(() => import('../epub/EpubReader'));
const PdfReader = lazy(() => import('../pdf/PdfReader'));

export default function ReaderPage() {
  const { id } = useParams<{ id: string }>();
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.getBook(id).then(setBook).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (book) document.title = `${book.title} — Quire`;
    return () => { document.title = 'Quire'; };
  }, [book]);

  if (error) {
    return (
      <div className="reader-error">
        <h2>Couldn’t open this book</h2>
        <p>{error}</p>
        <a className="btn btn-primary" href="/">Back to library</a>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="reader-error" aria-busy="true">
        <div className="book-loader" role="status" aria-label="Opening book"><span /><span /><span /></div>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="reader-error"><div className="book-loader" role="status" aria-label="Opening book"><span /><span /><span /></div></div>}>
      {book.format === 'epub' ? <EpubReader book={book} /> : <PdfReader book={book} />}
    </Suspense>
  );
}
