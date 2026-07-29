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

/**
 * Extract embedded metadata + cover image from an ePUB buffer.
 * Returns { title, author, description, publisher, publishedDate, language, isbn, cover: { data, ext } | null }
 */
export async function extractEpubMetadata(buffer, fallbackTitle) {
  const out = {
    title: fallbackTitle, author: null, description: null, publisher: null,
    publishedDate: null, language: null, isbn: null, cover: null,
  };
  const zip = await JSZip.loadAsync(buffer);

  const containerEntry = findEntry(zip, 'META-INF/container.xml');
  if (!containerEntry) return out;
  const container = parser.parse(await containerEntry.async('text'));
  const rootfiles = asArray(container?.container?.rootfiles?.rootfile);
  const opfPath = rootfiles[0]?.['@_full-path'];
  if (!opfPath) return out;

  const opfEntry = findEntry(zip, opfPath);
  if (!opfEntry) return out;
  const opf = parser.parse(await opfEntry.async('text'));
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
    if (entry) {
      out.cover = {
        data: await entry.async('nodebuffer'),
        ext: extForMime(coverItem['@_media-type']),
      };
    }
  }

  return out;
}
