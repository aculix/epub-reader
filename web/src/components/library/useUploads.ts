import { useCallback, useRef, useState } from 'react';
import { uploadBook, type Book } from '../../lib/api';
import { extractPdfExtras } from '../../pdf/pdfExtract';

export interface UploadItem {
  key: string;
  fileName: string;
  displayTitle: string;
  /** preparing → uploading → cataloguing (server metadata fetch) → error */
  stage: 'preparing' | 'uploading' | 'cataloguing' | 'error';
  fraction: number;
  error?: string;
}

let nextKey = 0;

export function useUploads(onBookAdded: (book: Book) => void) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const onAdded = useRef(onBookAdded);
  onAdded.current = onBookAdded;

  const patch = useCallback((key: string, changes: Partial<UploadItem>) => {
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...changes } : u)));
  }, []);

  const remove = useCallback((key: string) => {
    setUploads((list) => list.filter((u) => u.key !== key));
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const accepted = Array.from(files).filter((f) => /\.(epub|pdf)$/i.test(f.name));
      for (const file of accepted) {
        const key = `u${nextKey++}`;
        const displayTitle = file.name.replace(/\.(epub|pdf)$/i, '').replace(/[_.]+/g, ' ');
        setUploads((list) => [...list, { key, fileName: file.name, displayTitle, stage: 'preparing', fraction: 0 }]);

        (async () => {
          try {
            const extras = /\.pdf$/i.test(file.name) ? await extractPdfExtras(file) : {};
            patch(key, { stage: 'uploading', displayTitle: extras.title || displayTitle });
            const book = await uploadBook(file, extras, (fraction) => {
              patch(key, { fraction, stage: fraction >= 1 ? 'cataloguing' : 'uploading' });
            });
            onAdded.current(book);
            remove(key);
          } catch (err) {
            patch(key, { stage: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
          }
        })();
      }
      return accepted.length;
    },
    [patch, remove]
  );

  return { uploads, addFiles, dismissUpload: remove };
}
