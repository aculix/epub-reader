const GOOGLE_BOOKS = 'https://www.googleapis.com/books/v1/volumes';
const OPEN_LIBRARY = 'https://openlibrary.org';

async function fetchJson(url, timeoutMs = 6000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Quire/1.0 (self-hosted ebook reader)' },
  });
  if (!res.ok) throw new Error(`Metadata service responded ${res.status}`);
  return res.json();
}

function cleanTitleForQuery(title) {
  return (title || '')
    .replace(/\.(epub|pdf)$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*\((z-?lib(rary)?\.org|libgen[^)]*)\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Taleb, Nassim Nicholas" → "Nassim Nicholas Taleb" for friendlier queries/matching. */
function normalizeAuthor(author) {
  if (!author) return author;
  const m = author.match(/^([^,]+),\s*([^,]+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : author;
}

/** Word-overlap similarity (0..1) between two titles. */
function titleSimilarity(a, b) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const wa = new Set(norm(a));
  const wb = new Set(norm(b));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}

function authorsOverlap(want, got) {
  if (!want || !got) return false;
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, ' ');
  const wantWords = new Set(norm(normalizeAuthor(want)).split(/\s+/).filter((w) => w.length > 2));
  return norm(got).split(/\s+/).some((w) => w.length > 2 && wantWords.has(w));
}

// ---------------- Google Books ----------------

function pickVolume(items, { title, author, isbn }) {
  if (!items?.length) return null;
  let best = null;
  let bestScore = -1;
  for (const item of items.slice(0, 8)) {
    const v = item.volumeInfo || {};
    const sim = titleSimilarity(title, v.title);
    const authorOk = authorsOverlap(author, (v.authors || []).join(' '));
    // ISBN queries are already exact; otherwise demand real title/author agreement
    // so junk filenames don't confidently match the wrong book.
    if (!isbn && sim < 0.45 && !(sim >= 0.25 && authorOk)) continue;
    let score = sim * 4 + (authorOk ? 3 : 0);
    if (v.description) score += 2;
    if (v.imageLinks?.thumbnail) score += 1;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best;
}

async function lookupGoogleBooks({ title, author, isbn }) {
  let query;
  if (isbn) query = `isbn:${isbn}`;
  else if (title) {
    const t = cleanTitleForQuery(title);
    query = author ? `intitle:"${t}" inauthor:"${author}"` : `intitle:"${t}"`;
  } else return null;

  let data = await fetchJson(`${GOOGLE_BOOKS}?q=${encodeURIComponent(query)}&maxResults=8&printType=books`);
  if (!data.totalItems && !isbn && author) {
    data = await fetchJson(`${GOOGLE_BOOKS}?q=${encodeURIComponent(`intitle:"${cleanTitleForQuery(title)}"`)}&maxResults=8&printType=books`);
  }
  const item = pickVolume(data.items, { title: cleanTitleForQuery(title), author, isbn });
  if (!item) return null;

  const v = item.volumeInfo || {};
  const isbn13 = (v.industryIdentifiers || []).find((i) => i.type === 'ISBN_13')?.identifier;
  const isbn10 = (v.industryIdentifiers || []).find((i) => i.type === 'ISBN_10')?.identifier;

  let coverUrl = v.imageLinks?.extraLarge || v.imageLinks?.large || v.imageLinks?.medium || v.imageLinks?.small || v.imageLinks?.thumbnail || null;
  if (coverUrl) coverUrl = coverUrl.replace(/^http:/, 'https:').replace(/&edge=curl/, '');

  return {
    source: 'google-books',
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

// ---------------- Open Library ----------------

async function lookupOpenLibrary({ title, author, isbn }) {
  const fields = 'key,title,author_name,first_publish_year,cover_i,isbn,publisher,subject,number_of_pages_median,language';
  let url;
  if (isbn) {
    url = `${OPEN_LIBRARY}/search.json?q=${encodeURIComponent(`isbn:${isbn}`)}&limit=3&fields=${fields}`;
  } else if (title) {
    const params = new URLSearchParams({ title: cleanTitleForQuery(title), limit: '5', fields });
    if (author) params.set('author', normalizeAuthor(author));
    url = `${OPEN_LIBRARY}/search.json?${params}`;
  } else return null;

  let data = await fetchJson(url, 8000);
  if (!data.docs?.length && author && !isbn) {
    // Retry without the author constraint
    const params = new URLSearchParams({ title: cleanTitleForQuery(title), limit: '5', fields });
    data = await fetchJson(`${OPEN_LIBRARY}/search.json?${params}`, 8000);
  }
  const docs = data.docs || [];
  if (!docs.length) return null;

  let doc = null;
  let bestScore = -1;
  for (const d of docs) {
    const sim = titleSimilarity(cleanTitleForQuery(title || ''), d.title);
    const authorOk = authorsOverlap(author, (d.author_name || []).join(' '));
    if (!isbn && sim < 0.45 && !(sim >= 0.25 && authorOk)) continue;
    const score = sim * 4 + (authorOk ? 3 : 0) + (d.cover_i ? 1.5 : 0);
    if (score > bestScore) { bestScore = score; doc = d; }
  }
  if (!doc) {
    if (!isbn) return null;
    doc = docs[0];
  }

  // Description lives on the work record
  let description = null;
  if (doc.key) {
    try {
      const work = await fetchJson(`${OPEN_LIBRARY}${doc.key}.json`, 6000);
      const d = work.description;
      description = typeof d === 'string' ? d : d?.value || null;
    } catch { /* description is optional */ }
  }

  const isbn13 = (doc.isbn || []).find((i) => /^97[89]\d{10}$/.test(i));

  // Open Library subjects are noisy; keep a few short, comma-free, deduped ones
  const seen = new Set();
  const categories = [];
  for (const s of doc.subject || []) {
    if (s.includes(',') || s.includes(':') || s.length > 26) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    categories.push(s[0].toUpperCase() + s.slice(1));
    if (categories.length >= 3) break;
  }

  return {
    source: 'open-library',
    title: doc.title || null,
    author: (doc.author_name || []).join(', ') || null,
    description,
    publisher: (doc.publisher || [])[0] || null,
    publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : null,
    categories: categories.join(', ') || null,
    pageCount: doc.number_of_pages_median || null,
    language: (doc.language || []).includes('eng') ? 'en' : (doc.language || [])[0] || null,
    isbn: isbn13 || (doc.isbn || [])[0] || null,
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
  };
}

/**
 * Look up book metadata: Google Books first (richest descriptions), falling
 * back to Open Library (no API quota) when Google fails or finds nothing.
 */
export async function lookupMetadata({ title, author, isbn }) {
  let google = null;
  try {
    google = await lookupGoogleBooks({ title, author, isbn });
  } catch (err) {
    console.warn(`[enrich] Google Books lookup failed: ${err.message}`);
  }
  if (google?.description && google?.coverUrl) return google;

  let openLib = null;
  try {
    openLib = await lookupOpenLibrary({ title, author, isbn });
  } catch (err) {
    console.warn(`[enrich] Open Library lookup failed: ${err.message}`);
  }
  if (!google) return openLib;
  if (!openLib) return google;

  // Merge: prefer Google's richer prose, fill gaps from Open Library
  return {
    ...openLib,
    ...Object.fromEntries(Object.entries(google).filter(([, v]) => v != null)),
    description: google.description || openLib.description,
    coverUrl: google.coverUrl || openLib.coverUrl,
  };
}

/** Download a cover image; returns { data, ext } or null. */
export async function downloadCover(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0];
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.jpg';
    const data = Buffer.from(await res.arrayBuffer());
    return data.length > 500 ? { data, ext } : null;
  } catch {
    return null;
  }
}
