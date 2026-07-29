/**
 * Client-side PDF inspection at upload time: pull embedded title/author and
 * render page 1 as a cover image, so the server never needs a rasterizer.
 */
export async function extractPdfExtras(
  file: File
): Promise<{ title?: string; author?: string; cover?: Blob }> {
  try {
    const pdfjs = (await import('./pdfjs')).default;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;

    const out: { title?: string; author?: string; cover?: Blob } = {};

    try {
      const { info } = await doc.getMetadata();
      const meta = info as Record<string, unknown>;
      const title = typeof meta.Title === 'string' ? meta.Title.trim() : '';
      const author = typeof meta.Author === 'string' ? meta.Author.trim() : '';
      // PDF "titles" are frequently junk like "untitled" or the tool name
      if (title && title.length > 2 && !/^(untitled|microsoft word|document)/i.test(title)) {
        out.title = title;
      }
      if (author && !/^(user|admin|unknown)$/i.test(author)) out.author = author;
    } catch { /* metadata is optional */ }

    try {
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const targetWidth = 640;
      const scale = targetWidth / viewport.width;
      const scaled = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(scaled.width);
      canvas.height = Math.round(scaled.height);
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, viewport: scaled }).promise;
      out.cover = await new Promise<Blob | undefined>((resolve) =>
        canvas.toBlob((b) => resolve(b ?? undefined), 'image/png')
      );
    } catch { /* cover is optional */ }

    await doc.destroy();
    return out;
  } catch {
    return {};
  }
}
