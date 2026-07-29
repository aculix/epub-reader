# Quire

A beautiful, self-hosted ebook reader for the web — inspired by the Google Play Books experience, but running entirely on your own server.

Upload an ePUB or PDF and Quire automatically fetches its metadata (cover, description, author, categories) from Google Books, shelves it in a warm, literary library view, and opens it in a distraction-free reader with page-turn animations, themes, typography controls and synced reading progress.

## Features

- **Library** — cover-art grid, search, format filters, sorting, a "Continue reading" shelf, and drag-and-drop uploads with live progress
- **Automatic metadata** — embedded ePUB/PDF metadata is extracted on upload, then enriched via the Google Books API (description, categories, page count, high-res cover)
- **ePUB reader** — a custom-built engine (no epub.js): real pagination via CSS columns, animated page turns, single/two-page spreads, three reading themes (Paper / Sepia / Dusk), font family & size & line-spacing controls, table of contents, in-book links
- **PDF reader** — crisp canvas rendering, spreads, zoom, outline navigation, night (invert) mode
- **Progress sync** — your position is saved server-side per book; resume from any device on your network
- **Self-contained** — one Docker image, one `/data` volume (SQLite + your book files). No accounts, no cloud.

## Run with Docker

```bash
docker build -t quire .
docker run -d --name quire -p 3391:3391 -v quire-data:/data quire
```

or with compose:

```bash
docker compose up -d --build
```

Then open `http://localhost:3391` (or your server's address).

### Configuration

| Env var         | Default | Description                          |
| --------------- | ------- | ------------------------------------ |
| `PORT`          | `3391`  | HTTP port                            |
| `DATA_DIR`      | `/data` | Where the database and books live    |
| `MAX_UPLOAD_MB` | `300`   | Maximum upload size                  |

> **Note:** Quire has no built-in authentication — it is designed for a home network or to sit behind a reverse proxy (Authelia, Tailscale, basic auth, etc.).

## Develop locally

```bash
npm install
npm --prefix web install
npm run dev
```

- Web app: `http://localhost:5173` (proxies API calls)
- API: `http://localhost:3391`

## Architecture

```
server/          Express + SQLite (better-sqlite3)
  index.js       static serving + API mounting
  books.js       upload / list / file / cover / progress routes
  epubMeta.js    ePUB OPF parsing + cover extraction (JSZip)
  enrich.js      Google Books metadata lookup + cover download
web/             React + Vite + TypeScript
  src/epub/      custom ePUB engine (unzip → parse → paginate → animate)
  src/pdf/       pdf.js-based PDF reader + upload-time cover rendering
  src/reader/    shared reader chrome (bars, TOC, settings)
  src/pages/     Library & Reader routes
```

Book files are stored as `/data/books/<id>.<ext>`, covers as `/data/covers/<id>.<ext>`, metadata and reading progress in `/data/quire.db` (SQLite, WAL mode).
