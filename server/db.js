import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

fs.mkdirSync(path.join(DATA_DIR, 'books'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'covers'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'quire.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.prepare(`
  CREATE TABLE IF NOT EXISTS books (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    author         TEXT,
    description    TEXT,
    publisher      TEXT,
    published_date TEXT,
    categories     TEXT,
    isbn           TEXT,
    language       TEXT,
    page_count     INTEGER,
    format         TEXT NOT NULL CHECK (format IN ('epub', 'pdf')),
    file_name      TEXT NOT NULL,
    file_size      INTEGER NOT NULL,
    has_cover      INTEGER NOT NULL DEFAULT 0,
    enriched       INTEGER NOT NULL DEFAULT 0,
    added_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

// Lightweight migration: content hash for duplicate-upload detection
const bookColumns = db.prepare(`PRAGMA table_info(books)`).all().map((c) => c.name);
if (!bookColumns.includes('file_hash')) {
  db.prepare(`ALTER TABLE books ADD COLUMN file_hash TEXT`).run();
}

db.prepare(`
  CREATE TABLE IF NOT EXISTS progress (
    book_id    TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    location   TEXT,
    percent    REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

export default db;
