import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';
import db from './db.js';
import { DATA_DIR, MAX_UPLOAD_MB } from './config.js';
import { extractEpubMetadata, EpubValidationError } from './epubMeta.js';
import { lookupMetadata, downloadCover } from './enrich.js';

const router = Router();

const BOOKS_DIR = path.join(DATA_DIR, 'books');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, _file, cb) => cb(null, nanoid()),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

function titleFromFilename(name) {
  return path.basename(name).replace(/\.(epub|pdf)$/i, '').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

// Backfill hashes for books uploaded before duplicate detection existed
setTimeout(async () => {
  const rows = db.prepare(`SELECT id, format FROM books WHERE file_hash IS NULL`).all();
  for (const row of rows) {
    try {
      const p = path.join(BOOKS_DIR, `${row.id}.${row.format}`);
      if (fs.existsSync(p)) {
        db.prepare(`UPDATE books SET file_hash = ? WHERE id = ?`).run(await hashFile(p), row.id);
      }
    } catch { /* backfill is best-effort */ }
  }
}, 2000);

function detectFormat(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.pdf') return 'pdf';
  if (file.mimetype === 'application/epub+zip') return 'epub';
  if (file.mimetype === 'application/pdf') return 'pdf';
  return null;
}

function coverPathFor(id) {
  const match = fs.readdirSync(COVERS_DIR).find((f) => f.startsWith(`${id}.`));
  return match ? path.join(COVERS_DIR, match) : null;
}

function toJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    description: row.description,
    publisher: row.publisher,
    publishedDate: row.published_date,
    categories: row.categories ? row.categories.split(',').map((c) => c.trim()).filter(Boolean) : [],
    isbn: row.isbn,
    language: row.language,
    pageCount: row.page_count,
    format: row.format,
    fileName: row.file_name,
    fileSize: row.file_size,
    hasCover: !!row.has_cover,
    coverUrl: row.has_cover ? `/api/books/${row.id}/cover?v=${encodeURIComponent(row.updated_at)}` : null,
    enriched: !!row.enriched,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    progress: row.percent != null ? { percent: row.percent, location: row.location ? JSON.parse(row.location) : null, updatedAt: row.progress_updated_at } : null,
  };
}

const SELECT_BOOK = `
  SELECT b.*, p.percent, p.location, p.updated_at AS progress_updated_at
  FROM books b LEFT JOIN progress p ON p.book_id = b.id
`;

function saveCover(id, cover) {
  // Replace any previous cover regardless of extension
  for (const f of fs.readdirSync(COVERS_DIR)) {
    if (f.startsWith(`${id}.`)) fs.unlinkSync(path.join(COVERS_DIR, f));
  }
  fs.writeFileSync(path.join(COVERS_DIR, `${id}${cover.ext}`), cover.data);
}

/** Merge Google Books data into what we extracted; embedded fields win for title/author. */
async function enrichBook(base) {
  try {
    const found = await lookupMetadata({ title: base.title, author: base.author, isbn: base.isbn });
    if (!found) return { fields: {}, cover: null };
    const fields = {
      title: base.title || found.title,
      author: base.author || found.author,
      description: base.description || found.description,
      publisher: base.publisher || found.publisher,
      published_date: base.publishedDate || found.publishedDate,
      categories: found.categories,
      page_count: found.pageCount,
      language: base.language || found.language,
      isbn: base.isbn || found.isbn,
      enriched: 1,
    };
    const cover = !base.hasCover && found.coverUrl ? await downloadCover(found.coverUrl) : null;
    return { fields, cover };
  } catch (err) {
    console.warn(`[enrich] lookup failed for "${base.title}": ${err.message}`);
    return { fields: {}, cover: null };
  }
}

// ---------- routes ----------

router.get('/', (_req, res) => {
  const rows = db.prepare(`${SELECT_BOOK} ORDER BY b.added_at DESC`).all();
  res.json(rows.map(toJson));
});

router.post('/upload', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  const file = req.files?.file?.[0];
  const clientCover = req.files?.cover?.[0];
  const cleanup = () => {
    for (const f of [file, clientCover]) {
      if (f) fs.rm(f.path, { force: true }, () => {});
    }
  };

  try {
    if (!file) return res.status(400).json({ error: 'No file provided' });
    const format = detectFormat(file);
    if (!format) return res.status(415).json({ error: 'Only ePUB and PDF files are supported' });

    const id = nanoid(12);
    const fallbackTitle = titleFromFilename(file.originalname);

    // The same file twice is a mistake, not a request for a duplicate
    const fileHash = await hashFile(file.path);
    const existing = db.prepare(`SELECT title FROM books WHERE file_hash = ?`).get(fileHash);
    if (existing) {
      return res.status(409).json({ error: `“${existing.title}” is already in your library.` });
    }

    let meta = {
      title: req.body.title?.trim() || fallbackTitle,
      author: req.body.author?.trim() || null,
      description: null, publisher: null, publishedDate: null,
      language: null, isbn: null, cover: null,
    };

    if (format === 'epub') {
      try {
        const extracted = await extractEpubMetadata(fs.readFileSync(file.path), fallbackTitle);
        meta = { ...meta, ...Object.fromEntries(Object.entries(extracted).filter(([, v]) => v != null)) };
      } catch (err) {
        // Unopenable files are rejected with a reason the uploader can act on;
        // mere metadata hiccups still upload with filename-derived defaults.
        if (err instanceof EpubValidationError) {
          return res.status(422).json({ error: err.message });
        }
        console.warn(`[upload] ePUB metadata extraction failed: ${err.message}`);
      }
    }

    if (format === 'pdf') {
      // %PDF- magic may sit after a little junk, but must be near the start
      const head = Buffer.alloc(1024);
      const fd = fs.openSync(file.path, 'r');
      fs.readSync(fd, head, 0, 1024, 0);
      fs.closeSync(fd);
      if (!head.includes('%PDF-')) {
        return res.status(422).json({ error: 'This file isn’t a readable PDF — it may be corrupt or mislabelled.' });
      }
    }

    // Client-rendered PDF cover takes precedence for PDFs
    if (clientCover && !meta.cover) {
      meta.cover = { data: fs.readFileSync(clientCover.path), ext: '.png' };
    }

    const { fields: enrichedFields, cover: enrichedCover } = await enrichBook({
      title: meta.title, author: meta.author, description: meta.description,
      publisher: meta.publisher, publishedDate: meta.publishedDate,
      language: meta.language, isbn: meta.isbn, hasCover: !!meta.cover,
    });

    const finalCover = meta.cover || enrichedCover;
    const destPath = path.join(BOOKS_DIR, `${id}.${format}`);
    fs.copyFileSync(file.path, destPath);
    if (finalCover) saveCover(id, finalCover);

    db.prepare(`
      INSERT INTO books (id, title, author, description, publisher, published_date, categories, isbn, language, page_count, format, file_name, file_size, has_cover, enriched, file_hash)
      VALUES (@id, @title, @author, @description, @publisher, @published_date, @categories, @isbn, @language, @page_count, @format, @file_name, @file_size, @has_cover, @enriched, @file_hash)
    `).run({
      id,
      file_hash: fileHash,
      title: enrichedFields.title || meta.title,
      author: enrichedFields.author || meta.author,
      description: enrichedFields.description || meta.description,
      publisher: enrichedFields.publisher || meta.publisher,
      published_date: enrichedFields.published_date || meta.publishedDate,
      categories: enrichedFields.categories || null,
      isbn: enrichedFields.isbn || meta.isbn,
      language: enrichedFields.language || meta.language,
      page_count: enrichedFields.page_count || null,
      format,
      file_name: file.originalname,
      file_size: file.size,
      has_cover: finalCover ? 1 : 0,
      enriched: enrichedFields.enriched || 0,
    });

    const row = db.prepare(`${SELECT_BOOK} WHERE b.id = ?`).get(id);
    res.status(201).json(toJson(row));
  } catch (err) {
    console.error('[upload] failed:', err);
    res.status(500).json({ error: 'Upload failed' });
  } finally {
    cleanup();
  }
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT_BOOK} WHERE b.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Book not found' });
  res.json(toJson(row));
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Book not found' });

  const allowed = ['title', 'author', 'description', 'publisher', 'publishedDate', 'categories', 'isbn', 'language'];
  const colFor = { publishedDate: 'published_date' };
  const sets = [];
  const params = { id: req.params.id };
  for (const key of allowed) {
    if (key in req.body) {
      const col = colFor[key] || key;
      sets.push(`${col} = @${col}`);
      params[col] = Array.isArray(req.body[key]) ? req.body[key].join(', ') : (req.body[key] ?? null);
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE books SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
  }
  res.json(toJson(db.prepare(`${SELECT_BOOK} WHERE b.id = ?`).get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Book not found' });
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  fs.rm(path.join(BOOKS_DIR, `${row.id}.${row.format}`), { force: true }, () => {});
  const cover = coverPathFor(row.id);
  if (cover) fs.rm(cover, { force: true }, () => {});
  res.json({ ok: true });
});

router.post('/:id/refresh-metadata', async (req, res) => {
  try {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Book not found' });
  const { fields, cover } = await enrichBook({
    title: req.body?.title || row.title,
    author: req.body?.author || row.author,
    isbn: req.body?.isbn || row.isbn,
    hasCover: !!row.has_cover && !req.body?.replaceCover,
  });
  if (cover) saveCover(row.id, cover);
  if (Object.keys(fields).length) {
    // On explicit refresh the fetched values win over stale local ones.
    const merged = {
      id: row.id,
      title: fields.title || row.title,
      author: fields.author || row.author,
      description: fields.description || row.description,
      publisher: fields.publisher || row.publisher,
      published_date: fields.published_date || row.published_date,
      categories: fields.categories || row.categories,
      page_count: fields.page_count || row.page_count,
      language: fields.language || row.language,
      isbn: fields.isbn || row.isbn,
      has_cover: cover || row.has_cover ? 1 : 0,
    };
    db.prepare(`
      UPDATE books SET title=@title, author=@author, description=@description, publisher=@publisher,
        published_date=@published_date, categories=@categories, page_count=@page_count,
        language=@language, isbn=@isbn, has_cover=@has_cover, enriched=1, updated_at=datetime('now')
      WHERE id=@id
    `).run(merged);
  }
  res.json(toJson(db.prepare(`${SELECT_BOOK} WHERE b.id = ?`).get(req.params.id)));
  } catch (err) {
    console.error('[refresh-metadata] failed:', err);
    res.status(500).json({ error: 'Metadata refresh failed' });
  }
});

router.get('/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Book not found' });
  const filePath = path.join(BOOKS_DIR, `${row.id}.${row.format}`);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error: 'Book file missing on disk' });
  res.setHeader('Content-Type', row.format === 'epub' ? 'application/epub+zip' : 'application/pdf');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

router.get('/:id/cover', (req, res) => {
  const cover = coverPathFor(req.params.id);
  if (!cover) return res.status(404).json({ error: 'No cover' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(cover);
});

router.put('/:id/progress', (req, res) => {
  const row = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Book not found' });
  const percent = Math.min(1, Math.max(0, Number(req.body?.percent) || 0));
  const location = req.body?.location ? JSON.stringify(req.body.location) : null;
  db.prepare(`
    INSERT INTO progress (book_id, location, percent, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(book_id) DO UPDATE SET location=excluded.location, percent=excluded.percent, updated_at=excluded.updated_at
  `).run(req.params.id, location, percent);
  res.json({ ok: true });
});

export default router;
