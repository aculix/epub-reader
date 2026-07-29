export interface BookProgress {
  percent: number;
  location: EpubLocation | PdfLocation | null;
  updatedAt: string;
}

export interface EpubLocation {
  kind: 'epub';
  spineIndex: number;
  fraction: number; // position within the chapter, 0..1
}

export interface PdfLocation {
  kind: 'pdf';
  page: number;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  categories: string[];
  isbn: string | null;
  language: string | null;
  pageCount: number | null;
  format: 'epub' | 'pdf';
  fileName: string;
  fileSize: number;
  hasCover: boolean;
  coverUrl: string | null;
  enriched: boolean;
  addedAt: string;
  updatedAt: string;
  progress: BookProgress | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listBooks: (): Promise<Book[]> => fetch('/api/books').then((r) => json<Book[]>(r)),

  getBook: (id: string): Promise<Book> => fetch(`/api/books/${id}`).then((r) => json<Book>(r)),

  deleteBook: (id: string): Promise<void> =>
    fetch(`/api/books/${id}`, { method: 'DELETE' }).then((r) => json(r)),

  updateBook: (id: string, fields: Partial<Book>): Promise<Book> =>
    fetch(`/api/books/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then((r) => json<Book>(r)),

  refreshMetadata: (id: string): Promise<Book> =>
    fetch(`/api/books/${id}/refresh-metadata`, { method: 'POST' }).then((r) => json<Book>(r)),

  saveProgress: (id: string, percent: number, location: EpubLocation | PdfLocation): Promise<void> =>
    fetch(`/api/books/${id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ percent, location }),
      keepalive: true,
    }).then((r) => json(r)),

  fileUrl: (id: string) => `/api/books/${id}/file`,
};

/**
 * Upload with progress callbacks (XHR — fetch has no upload progress).
 * `extras` carries client-extracted PDF metadata and rendered cover.
 */
export function uploadBook(
  file: File,
  extras: { title?: string; author?: string; cover?: Blob },
  onProgress: (fraction: number) => void
): Promise<Book> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    if (extras.title) form.append('title', extras.title);
    if (extras.author) form.append('author', extras.author);
    if (extras.cover) form.append('cover', extras.cover, 'cover.png');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/books/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as Book);
      } else {
        let message = `Upload failed (${xhr.status})`;
        try {
          message = (JSON.parse(xhr.responseText) as { error?: string }).error || message;
        } catch { /* keep default */ }
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(form);
  });
}
