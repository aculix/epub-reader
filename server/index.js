import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import booksRouter from './books.js';
import { PORT, ROOT_DIR, DATA_DIR } from './config.js';

// A single failed request must never take the server down with it
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use('/api/books', booksRouter);
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'quire' }));

// Serve the built frontend (production / Docker)
const distDir = path.join(ROOT_DIR, 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: false }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('Quire API is running. Frontend build not found — run `npm run build` or use the Docker image.');
  });
}

app.listen(PORT, () => {
  console.log(`Quire listening on http://localhost:${PORT}  (data: ${DATA_DIR})`);
});
