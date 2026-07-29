const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';

async function fetchJson(url, timeoutMs = 6000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Quire/1.0 (self-hosted ebook reader)' },
  });
  if (!res.ok) throw new Error(`Google Books responded ${res.status}`);
  return res.json();
}

function cleanTitleForQuery(title) {
  return title
    .replace(/\.(epub|pdf)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*\((z-?lib(rary)?\.org|libgen[^)]*)\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickVolume(items, { title, author }) {
  if (!items?.length) return null;
  const wantTitle = title.toLowerCase();
  const wantAuthor = (author || '').toLowerCase();
  // Prefer results whose title/author overlap the query; Google's first hit is
  // usually right, but scoring guards against loose matches on short queries.
  let best = null;
  let bestScore = -1;
  for (const item of items.slice(0, 8)) {
    const v = item.volumeInfo || {};
    let score = 0;
    const gotTitle = (v.title || '').toLowerCase();
    if (gotTitle === wantTitle) score += 4;
    else if (gotTitle && (wantTitle.includes(gotTitle) || gotTitle.includes(wantTitle))) score += 2;
    if (wantAuthor && (v.authors || []).some((a) => wantAuthor.includes(a.toLowerCase()) || a.toLowerCase().includes(wantAuthor))) score += 3;
    if (v.description) score += 2;
    if (v.imageLinks?.thumbnail) score += 1;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 2 ? best : items[0];
}

/**
 * Look up a book on Google Books by ISBN (preferred) or title/author.
 * Returns partial metadata fields, plus coverUrl when a cover is available.
 */
export async function lookupGoogleBooks({ title, author, isbn }) {
  let query;
  if (isbn) {
    query = `isbn:${isbn}`;
  } else if (title) {
    const t = cleanTitleForQuery(title);
    query = author ? `intitle:"${t}" inauthor:"${author}"` : `intitle:"${t}"`;
  } else {
    return null;
  }

  let data = await fetchJson(`${GOOGLE_BOOKS}?q=${encodeURIComponent(query)}&maxResults=8&printType=books`);
  if (!data.totalItems && !isbn && author) {
    // Retry looser: title-only search
    data = await fetchJson(`${GOOGLE_BOOKS}?q=${encodeURIComponent(`intitle:"${cleanTitleForQuery(title)}"`)}&maxResults=8&printType=books`);
  }
  const item = pickVolume(data.items, { title: cleanTitleForQuery(title || ''), author });
  if (!item) return null;

  const v = item.volumeInfo || {};
  const isbn13 = (v.industryIdentifiers || []).find((i) => i.type === 'ISBN_13')?.identifier;
  const isbn10 = (v.industryIdentifiers || []).find((i) => i.type === 'ISBN_10')?.identifier;

  // Google serves http:// thumbnails; upgrade and strip the page-curl overlay.
  let coverUrl = v.imageLinks?.extraLarge || v.imageLinks?.large || v.imageLinks?.medium || v.imageLinks?.small || v.imageLinks?.thumbnail || null;
  if (coverUrl) coverUrl = coverUrl.replace(/^http:/, 'https:').replace(/&edge=curl/, '');

  return {
    title: v.title || null,
    author: (v.authors || []).join(', ') || null,
    description: v.description || null,
    publisher: v.publisher || null,
    publishedDate: v.publishedDate || null,
    categories: (v.categories || []).join(', ') || null,
    pageCount: v.pageCount || null,
    language: v.language || null,
    isbn: isbn13 || isbn10 || null,
    coverUrl,
  };
}

/** Download a cover image; returns { data, ext } or null. */
export async function downloadCover(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0];
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.jpg';
    const data = Buffer.from(await res.arrayBuffer());
    return data.length > 500 ? { data, ext } : null;
  } catch {
    return null;
  }
}
