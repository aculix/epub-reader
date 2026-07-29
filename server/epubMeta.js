import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
});

// XML text nodes come back as strings, numbers, or { '#text': ... } objects
// depending on whether the element carries attributes.
function textOf(node) {
  if (node == null) return null;
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return textOf(node['#text']);
  const s = String(node).trim();
  return s.length ? s : null;
}

function asArray(node) {
  if (node == null) return [];
  return Array.isArray(node) ? node : [node];
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function extForMime(mime) {
  return { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[mime] || '.jpg';
}

// Caps on decompressed sizes so a crafted ePUB (zip bomb) can't OOM the process.
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_COVER_BYTES = 30 * 1024 * 1024;

function declaredSize(entry) {
  // JSZip keeps the central-directory uncompressed size internally
  const size = entry?._data?.uncompressedSize;
  return typeof size === 'number' && size >= 0 ? size : null;
}

async function safeText(entry, cap = MAX_TEXT_BYTES) {
  if (!entry) return null;
  const size = declaredSize(entry);
  if (size !== null && size > cap) throw new Error(`ePUB entry too large (${size} bytes)`);
  const text = await entry.async('text');
  if (text.length > cap) throw new Error('ePUB entry exceeded size cap while inflating');
  return text;
}

// Zip entry lookups must tolerate href percent-encoding and case drift.
function findEntry(zip, p) {
  if (zip.files[p]) return zip.files[p];
  const decoded = decodeURIComponent(p);
  if (zip.files[decoded]) return zip.files[decoded];
  const lower = decoded.toLowerCase();
  const key = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
  return key ? zip.files[key] : null;
}

function resolveHref(opfDir, href) {
  const joined = opfDir ? `${opfDir}/${href}` : href;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** Raised when a file cannot possibly be read as an ePUB — surfaced to the uploader. */
export class EpubValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Extract embedded metadata + cover image from an ePUB buffer.
 * Throws EpubValidationError for files Quire will never be able to open
 * (not a zip, missing package structure, DRM-encrypted content).
 * Returns { title, author, description, publisher, publishedDate, language, isbn, cover: { data, ext } | null }
 */
export async function extractEpubMetadata(buffer, fallbackTitle) {
  const out = {
    title: fallbackTitle, author: null, description: null, publisher: null,
    publishedDate: null, language: null, isbn: null, cover: null,
  };

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new EpubValidationError(
      'INVALID_EPUB',
      'This file isn’t a readable ePUB — it may be corrupt, truncated, or not an ePUB at all.'
    );
  }

  const containerEntry = findEntry(zip, 'META-INF/container.xml');
  if (!containerEntry) {
    throw new EpubValidationError(
      'INVALID_EPUB',
      'This ePUB is missing its package structure (META-INF/container.xml), so it can’t be opened.'
    );
  }

  // Adobe/B&N-style DRM: encryption.xml covering content files (font
  // obfuscation alone is fine and common)
  const encEntry = findEntry(zip, 'META-INF/encryption.xml');
  if (encEntry) {
    try {
      const encXml = await safeText(encEntry);
      const uris = [...encXml.matchAll(/CipherReference[^>]*URI\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
      const nonFont = uris.filter((u) => !/\.(ttf|otf|woff2?)(\?|#|$)/i.test(u));
      if (nonFont.length > 0) {
        throw new EpubValidationError(
          'DRM_EPUB',
          'This ePUB is protected by DRM, so Quire can’t open it. Upload a DRM-free copy instead.'
        );
      }
    } catch (err) {
      if (err instanceof EpubValidationError) throw err;
      /* unreadable encryption.xml — don't block on it */
    }
  }

  const container = parser.parse(await safeText(containerEntry));
  const rootfiles = asArray(container?.container?.rootfiles?.rootfile);
  const opfPath = rootfiles[0]?.['@_full-path'];
  if (!opfPath) {
    throw new EpubValidationError('INVALID_EPUB', 'This ePUB has no package document listed, so it can’t be opened.');
  }

  const opfEntry = findEntry(zip, opfPath);
  if (!opfEntry) {
    throw new EpubValidationError('INVALID_EPUB', 'This ePUB’s package document is missing, so it can’t be opened.');
  }
  const opf = parser.parse(await safeText(opfEntry));
  const pkg = opf?.package;
  if (!pkg) return out;

  const meta = pkg.metadata || {};
  out.title = textOf(meta.title) || fallbackTitle;
  out.author = asArray(meta.creator).map(textOf).filter(Boolean).join(', ') || null;
  out.description = textOf(meta.description);
  out.publisher = textOf(meta.publisher);
  out.publishedDate = textOf(meta.date);
  out.language = textOf(meta.language);

  for (const ident of asArray(meta.identifier)) {
    const value = textOf(ident);
    if (!value) continue;
    const digits = value.replace(/[^0-9Xx]/g, '');
    if (/isbn/i.test(String(ident?.['@_scheme'] || '')) || /^97[89]\d{10}$/.test(digits)) {
      out.isbn = digits;
      break;
    }
  }

  // --- Cover discovery, in order of reliability ---
  const items = asArray(pkg.manifest?.item);
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  let coverItem =
    // ePUB 3: manifest item flagged as the cover image
    items.find((i) => String(i['@_properties'] || '').split(/\s+/).includes('cover-image')) ||
    null;

  if (!coverItem) {
    // ePUB 2: <meta name="cover" content="item-id">
    const coverId = asArray(meta.meta).find((m) => m?.['@_name'] === 'cover')?.['@_content'];
    if (coverId) coverItem = items.find((i) => i['@_id'] === coverId) || null;
  }
  if (!coverItem) {
    coverItem = items.find(
      (i) => IMAGE_TYPES.has(i['@_media-type']) && /cover/i.test(`${i['@_id']} ${i['@_href']}`)
    ) || null;
  }
  if (!coverItem) {
    coverItem = items.find((i) => IMAGE_TYPES.has(i['@_media-type'])) || null;
  }

  if (coverItem?.['@_href']) {
    const entry = findEntry(zip, resolveHref(opfDir, coverItem['@_href']));
    const size = declaredSize(entry);
    if (entry && (size === null || size <= MAX_COVER_BYTES)) {
      const data = await entry.async('nodebuffer');
      if (data.length <= MAX_COVER_BYTES) {
        out.cover = { data, ext: extForMime(coverItem['@_media-type']) };
      }
    }
  }

  return out;
}
