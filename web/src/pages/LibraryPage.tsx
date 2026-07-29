import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, type Book } from '../lib/api';
import { useUploads } from '../components/library/useUploads';
import BookCard from '../components/library/BookCard';
import UploadCard from '../components/library/UploadCard';
import BookDetailModal from '../components/library/BookDetailModal';
import ContinueReading from '../components/library/ContinueReading';
import DropOverlay from '../components/library/DropOverlay';
import { IconPlus, IconSearch, IconBook } from '../components/Icons';
import '../styles/library.css';

type FormatFilter = 'all' | 'epub' | 'pdf';
type Sort = 'recent' | 'title' | 'author';

export default function LibraryPage() {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState<FormatFilter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [selected, setSelected] = useState<Book | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Book | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const { uploads, addFiles, dismissUpload } = useUploads((book) => {
    setBooks((list) => [book, ...(list ?? [])]);
  });

  // Every dropped/picked file gets visible feedback — never a silent no-op
  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const { accepted, skipped } = addFiles(files);
      if (skipped > 0) {
        setToast(
          accepted > 0
            ? `${skipped} file${skipped === 1 ? ' was' : 's were'} skipped — Quire reads ePUB and PDF files.`
            : 'Only ePUB and PDF files are supported.'
        );
      }
    },
    [addFiles]
  );

  useEffect(() => {
    document.title = 'Quire — Library';
    api.listBooks().then(setBooks).catch((e) => setLoadError(e.message));
  }, []);

  // Whole-window drag & drop
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) handleFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFiles]);

  const visibleBooks = useMemo(() => {
    if (!books) return [];
    const q = query.trim().toLowerCase();
    let list = books.filter((b) => {
      if (format !== 'all' && b.format !== format) return false;
      if (q && !`${b.title} ${b.author ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'author') list = [...list].sort((a, b) => (a.author ?? '~').localeCompare(b.author ?? '~'));
    return list;
  }, [books, query, format, sort]);

  const continueBook = useMemo(() => {
    if (!books || query || format !== 'all') return null;
    return (
      books
        .filter((b) => b.progress && b.progress.percent > 0.001 && b.progress.percent < 0.995)
        .sort((a, b) => (b.progress!.updatedAt > a.progress!.updatedAt ? 1 : -1))[0] ?? null
    );
  }, [books, query, format]);

  const handleRefresh = async (book: Book) => {
    try {
      const updated = await api.refreshMetadata(book.id);
      setBooks((list) => (list ?? []).map((b) => (b.id === updated.id ? updated : b)));
      setSelected((s) => (s?.id === updated.id ? updated : s));
    } catch (err) {
      setToast(`Couldn’t refresh metadata: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  const handleDelete = async (book: Book) => {
    try {
      await api.deleteBook(book.id);
      setBooks((list) => (list ?? []).filter((b) => b.id !== book.id));
      setSelected((s) => (s?.id === book.id ? null : s));
    } catch (err) {
      setToast(`Couldn’t remove the book: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setConfirmDelete(null);
    }
  };

  // Error toasts auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Escape closes the topmost layer only (confirm dialog above detail modal)
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setConfirmDelete(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmDelete]);

  const isEmpty = books !== null && books.length === 0 && uploads.length === 0;

  return (
    <div className="library">
      <header className="lib-header">
        <div className="lib-header-inner">
          <a className="wordmark" href="/">
            <img src="/quire.svg" alt="" width={30} height={30} />
            <span>Quire</span>
          </a>

          <div className="lib-search">
            <IconSearch />
            <input
              type="search"
              placeholder="Search your library"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search your library"
            />
          </div>

          <div className="lib-header-actions">
            <button className="btn btn-primary" onClick={() => fileInput.current?.click()} aria-label="Add books">
              <IconPlus style={{ width: 17, height: 17 }} /> <span className="btn-label">Add books</span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".epub,.pdf,application/epub+zip,application/pdf"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) handleFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </header>

      <main className="lib-main">
        {loadError && (
          <div className="lib-error">Couldn’t reach the Quire server: {loadError}</div>
        )}

        {continueBook && <ContinueReading book={continueBook} />}

        {books === null && !loadError && (
          <div className="shelf-grid" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="book-card skeleton" key={i} style={{ animationDelay: `${i * 90}ms` }}>
                <div className="book-cover" />
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
              </div>
            ))}
          </div>
        )}

        {books !== null && !isEmpty && (
          <>
            <div className="shelf-toolbar">
              <h1 className="shelf-title">
                Your library <span className="shelf-count">{visibleBooks.length}</span>
              </h1>
              <div className="shelf-controls">
                <div className="chip-row" role="tablist" aria-label="Filter by format">
                  {(['all', 'epub', 'pdf'] as const).map((f) => (
                    <button
                      key={f}
                      role="tab"
                      aria-selected={format === f}
                      className={`chip ${format === f ? 'chip-active' : ''}`}
                      onClick={() => setFormat(f)}
                    >
                      {f === 'all' ? 'All' : f === 'epub' ? 'ePUB' : 'PDF'}
                    </button>
                  ))}
                </div>
                <select className="sort-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
                  <option value="recent">Recently added</option>
                  <option value="title">Title</option>
                  <option value="author">Author</option>
                </select>
              </div>
            </div>

            <motion.div className="shelf-grid" layout>
              <AnimatePresence mode="popLayout">
                {uploads.map((u) => (
                  <UploadCard key={u.key} item={u} onDismiss={() => dismissUpload(u.key)} />
                ))}
                {visibleBooks.map((book, i) => (
                  <BookCard
                    key={book.id}
                    book={book}
                    index={i}
                    onDetails={setSelected}
                    onRefresh={handleRefresh}
                    onDelete={setConfirmDelete}
                  />
                ))}
              </AnimatePresence>
            </motion.div>

            {visibleBooks.length === 0 && uploads.length === 0 && (
              <div className="no-results">
                <p>Nothing matches “{query}”.</p>
              </div>
            )}
          </>
        )}

        {isEmpty && (
          <motion.div
            className="empty-state"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="empty-shelf" aria-hidden>
              <span className="empty-book b1" /><span className="empty-book b2" /><span className="empty-book b3" />
            </div>
            <h1>A quiet shelf, waiting.</h1>
            <p>Drop an ePUB or PDF anywhere on this page — Quire will fetch its cover, description and details automatically.</p>
            <button className="btn btn-primary" onClick={() => fileInput.current?.click()}>
              <IconBook style={{ width: 18, height: 18 }} /> Add your first book
            </button>
          </motion.div>
        )}
      </main>

      <AnimatePresence>{dragging && <DropOverlay />}</AnimatePresence>

      <AnimatePresence>
        {selected && (
          <BookDetailModal
            book={selected}
            onClose={() => setSelected(null)}
            onRefresh={handleRefresh}
            onDelete={(b) => setConfirmDelete(b)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            className="toast"
            role="alert"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setConfirmDelete(null)}
          >
            <motion.div
              className="confirm-modal"
              role="alertdialog"
              aria-label={`Remove ${confirmDelete.title}`}
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3>Remove “{confirmDelete.title}”?</h3>
              <p>The book file and your reading progress will be deleted from this server.</p>
              <div className="confirm-actions">
                <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Keep it</button>
                <button className="btn btn-primary btn-danger-solid" onClick={() => handleDelete(confirmDelete)}>Remove</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
