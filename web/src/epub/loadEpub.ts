import JSZip from 'jszip';

/**
 * Quire's own ePUB engine (no epub.js).
 *
 * Responsibilities:
 *  - unzip the .epub and parse container.xml → OPF → manifest + spine + TOC
 *  - prepare chapter documents for rendering: strip scripts, rewrite every
 *    resource reference (images, stylesheets, fonts) to blob: URLs served
 *    from the zip, and tag internal links for interception
 */

export interface SpineItem {
  idref: string;
  path: string; // resolved path inside the zip
  bytes: number; // uncompressed size, used to weight book-level progress
}

export interface TocEntry {
  label: string;
  href: string; // resolved zip path + optional #hash
  depth: number;
  spineIndex: number; // -1 if not found in spine
}

export interface PreparedChapter {
  html: string; // full srcdoc document, resources rewritten
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', css: 'text/css',
  otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
  xhtml: 'application/xhtml+xml', html: 'text/html',
};

function mimeFor(path: string, manifestType?: string): string {
  if (manifestType) return manifestType;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/** Resolve `href` relative to the directory of `fromPath` (both zip paths). */
export function resolvePath(fromPath: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
  if (!clean) return fromPath;
  const baseParts = fromPath.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '..') baseParts.pop();
    else if (seg !== '.' && seg !== '') baseParts.push(seg);
  }
  return baseParts.join('/');
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, 'application/xml');
}

export class EpubBook {
  title = 'Untitled';
  language = 'en';
  spine: SpineItem[] = [];
  toc: TocEntry[] = [];
  totalBytes = 0;
  /** prefix sums of spine item bytes, for weighted progress */
  bytesBefore: number[] = [];

  private zip!: JSZip;
  private manifest = new Map<string, { path: string; mediaType: string }>(); // id → entry
  private blobUrls = new Map<string, Promise<string | null>>(); // zip path → blob url
  private chapterCache = new Map<number, PreparedChapter>();
  private pathToSpine = new Map<string, number>();

  static async open(data: ArrayBuffer): Promise<EpubBook> {
    const book = new EpubBook();
    await book.init(data);
    return book;
  }

  private entry(path: string) {
    const zip = this.zip;
    if (zip.files[path]) return zip.files[path];
    const decoded = decodeURIComponent(path);
    if (zip.files[decoded]) return zip.files[decoded];
    const lower = decoded.toLowerCase();
    const key = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
    return key ? zip.files[key] : null;
  }

  private async init(data: ArrayBuffer) {
    this.zip = await JSZip.loadAsync(data);

    const containerText = await this.entry('META-INF/container.xml')?.async('text');
    if (!containerText) throw new Error('Not a valid ePUB (missing container.xml)');
    const container = parseXml(containerText);
    const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) throw new Error('Not a valid ePUB (no rootfile)');

    const opfText = await this.entry(opfPath)?.async('text');
    if (!opfText) throw new Error('Not a valid ePUB (missing package document)');
    const opf = parseXml(opfText);

    // dc:title / dc:language — namespace-safe lookup
    for (const el of Array.from(opf.getElementsByTagName('*'))) {
      if (el.localName === 'title' && this.title === 'Untitled' && el.textContent?.trim()) {
        this.title = el.textContent.trim();
      }
      if (el.localName === 'language' && el.textContent?.trim()) {
        this.language = el.textContent.trim().split('-')[0];
      }
    }

    let navPath: string | null = null;
    let ncxPath: string | null = null;

    for (const item of Array.from(opf.querySelectorAll('manifest > item'))) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type') || '';
      if (!id || !href) continue;
      const path = resolvePath(opfPath, href);
      this.manifest.set(id, { path, mediaType });
      const props = (item.getAttribute('properties') || '').split(/\s+/);
      if (props.includes('nav')) navPath = path;
      if (mediaType === 'application/x-dtbncx+xml') ncxPath = path;
    }

    const spineEl = opf.querySelector('spine');
    const tocAttr = spineEl?.getAttribute('toc');
    if (!ncxPath && tocAttr) ncxPath = this.manifest.get(tocAttr)?.path ?? null;

    for (const itemref of Array.from(opf.querySelectorAll('spine > itemref'))) {
      if (itemref.getAttribute('linear') === 'no') continue;
      const idref = itemref.getAttribute('idref');
      const m = idref ? this.manifest.get(idref) : null;
      if (!m) continue;
      const entry = this.entry(m.path);
      if (!entry) continue;
      // @ts-expect-error _data is internal but the only sync way to get sizes
      const bytes: number = entry._data?.uncompressedSize > 0 ? entry._data.uncompressedSize : 50_000;
      this.pathToSpine.set(m.path, this.spine.length);
      this.spine.push({ idref: idref!, path: m.path, bytes });
    }

    if (!this.spine.length) throw new Error('This ePUB has no readable chapters');

    let acc = 0;
    for (const s of this.spine) {
      this.bytesBefore.push(acc);
      acc += s.bytes;
    }
    this.totalBytes = acc;

    try {
      if (navPath) await this.parseNavToc(navPath);
      else if (ncxPath) await this.parseNcxToc(ncxPath);
    } catch {
      this.toc = [];
    }
    if (!this.toc.length) {
      // Fallback: one entry per spine chapter
      this.toc = this.spine.map((s, i) => ({
        label: `Section ${i + 1}`, href: s.path, depth: 0, spineIndex: i,
      }));
    }
  }

  private async parseNavToc(navPath: string) {
    const text = await this.entry(navPath)?.async('text');
    if (!text) return;
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    const navs = Array.from(doc.querySelectorAll('nav'));
    const tocNav =
      navs.find((n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type')) === 'toc') ||
      navs[0];
    if (!tocNav) return;
    const walk = (ol: Element, depth: number) => {
      for (const li of Array.from(ol.children).filter((c) => c.localName === 'li')) {
        const a = Array.from(li.children).find((c) => c.localName === 'a') as HTMLAnchorElement | undefined;
        const href = a?.getAttribute('href');
        if (a && href) {
          const hash = href.includes('#') ? '#' + href.split('#')[1] : '';
          const path = resolvePath(navPath, href);
          this.toc.push({
            label: a.textContent?.replace(/\s+/g, ' ').trim() || 'Untitled',
            href: path + hash,
            depth,
            spineIndex: this.pathToSpine.get(path) ?? -1,
          });
        }
        const childOl = Array.from(li.children).find((c) => c.localName === 'ol');
        if (childOl) walk(childOl, depth + 1);
      }
    };
    const rootOl = Array.from(tocNav.children).find((c) => c.localName === 'ol');
    if (rootOl) walk(rootOl, 0);
  }

  private async parseNcxToc(ncxPath: string) {
    const text = await this.entry(ncxPath)?.async('text');
    if (!text) return;
    const doc = parseXml(text);
    const walk = (parent: Element, depth: number) => {
      for (const navPoint of Array.from(parent.children).filter((c) => c.localName === 'navPoint')) {
        const label = navPoint.querySelector('navLabel > text')?.textContent?.replace(/\s+/g, ' ').trim();
        const src = navPoint.querySelector('content')?.getAttribute('src');
        if (label && src) {
          const hash = src.includes('#') ? '#' + src.split('#')[1] : '';
          const path = resolvePath(ncxPath, src);
          this.toc.push({ label, href: path + hash, depth, spineIndex: this.pathToSpine.get(path) ?? -1 });
        }
        walk(navPoint, depth + 1);
      }
    };
    const navMap = doc.querySelector('navMap');
    if (navMap) walk(navMap, 0);
  }

  /** Blob URL for any resource inside the zip (cached). */
  private blobUrlFor(path: string, mediaType?: string): Promise<string | null> {
    let cached = this.blobUrls.get(path);
    if (!cached) {
      cached = (async () => {
        const entry = this.entry(path);
        if (!entry) return null;
        if (mimeFor(path, mediaType) === 'text/css') {
          const css = await entry.async('text');
          const rewritten = await this.rewriteCssUrls(css, path);
          return URL.createObjectURL(new Blob([rewritten], { type: 'text/css' }));
        }
        const data = await entry.async('blob');
        return URL.createObjectURL(new Blob([data], { type: mimeFor(path, mediaType) }));
      })();
      this.blobUrls.set(path, cached);
    }
    return cached;
  }

  /** Rewrite url(...) references inside CSS (fonts, images) to blob URLs. */
  private async rewriteCssUrls(css: string, cssPath: string): Promise<string> {
    const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const matches = [...css.matchAll(urlRe)];
    const replacements = new Map<string, string>();
    for (const m of matches) {
      const ref = m[2].trim();
      if (/^(data:|https?:|blob:)/i.test(ref)) continue;
      const resolved = resolvePath(cssPath, ref);
      const blobUrl = await this.blobUrlFor(resolved);
      if (blobUrl) replacements.set(m[0], `url("${blobUrl}")`);
    }
    let out = css;
    for (const [from, to] of replacements) out = out.replaceAll(from, to);
    // Drop @import (rarely used; avoiding recursive fetches keeps this predictable)
    return out.replace(/@import[^;]+;/g, '');
  }

  hrefToSpine(href: string): { spineIndex: number; hash: string } {
    const [path, hash] = href.split('#');
    return { spineIndex: this.pathToSpine.get(path) ?? -1, hash: hash ? `#${hash}` : '' };
  }

  /** Book-level progress (0..1) from a chapter index + in-chapter fraction, weighted by chapter size. */
  progressFor(spineIndex: number, fraction: number): number {
    if (!this.totalBytes) return 0;
    const clamped = Math.min(this.spine.length - 1, Math.max(0, spineIndex));
    return Math.min(1, (this.bytesBefore[clamped] + fraction * this.spine[clamped].bytes) / this.totalBytes);
  }

  async prepareChapter(spineIndex: number): Promise<PreparedChapter> {
    const cached = this.chapterCache.get(spineIndex);
    if (cached) return cached;

    const item = this.spine[spineIndex];
    if (!item) throw new Error(`No chapter at index ${spineIndex}`);
    const raw = (await this.entry(item.path)?.async('text')) ?? '';

    let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
    if (doc.querySelector('parsererror')) {
      doc = new DOMParser().parseFromString(raw, 'text/html');
    }

    // Strip anything executable or external-fetching that we don't control
    doc.querySelectorAll('script, iframe, object, embed, form, video, audio').forEach((el) => el.remove());
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    }

    // Resolve resources → blob URLs
    const tasks: Promise<void>[] = [];
    const resolveAttr = (el: Element, attr: string) => {
      const val = el.getAttribute(attr);
      if (!val || /^(data:|https?:|blob:|#)/i.test(val)) return;
      const resolved = resolvePath(item.path, val);
      tasks.push(
        this.blobUrlFor(resolved).then((url) => {
          if (url) el.setAttribute(attr, url);
          else el.removeAttribute(attr);
        })
      );
    };

    doc.querySelectorAll('img[src]').forEach((el) => resolveAttr(el, 'src'));
    doc.querySelectorAll('image').forEach((el) => {
      resolveAttr(el, 'href');
      const xlink = el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (xlink && !/^(data:|https?:|blob:)/i.test(xlink)) {
        const resolved = resolvePath(item.path, xlink);
        tasks.push(
          this.blobUrlFor(resolved).then((url) => {
            if (url) el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
          })
        );
      }
    });
    doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach((el) => resolveAttr(el, 'href'));

    // Inline <style> blocks may reference package resources too
    for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
      const css = styleEl.textContent || '';
      if (css.includes('url(')) {
        tasks.push(
          this.rewriteCssUrls(css, item.path).then((rewritten) => {
            styleEl.textContent = rewritten;
          })
        );
      }
    }

    // Internal links → intercepted; external links → new tab
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href')!;
      if (/^(https?:|mailto:)/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      } else if (!href.startsWith('#')) {
        const hash = href.includes('#') ? '#' + href.split('#')[1] : '';
        a.setAttribute('data-quire-href', resolvePath(item.path, href) + hash);
        a.removeAttribute('href');
      }
    });

    await Promise.all(tasks);

    const serializer = new XMLSerializer();
    const headParts: string[] = [];
    doc.querySelectorAll('link[rel~="stylesheet"], style').forEach((el) => {
      headParts.push(serializer.serializeToString(el));
    });
    const bodyEl = doc.body ?? doc.documentElement;
    const bodyHtml = Array.from(bodyEl.childNodes).map((n) => serializer.serializeToString(n)).join('');
    const bodyClass = bodyEl.getAttribute('class') || '';

    const html = [
      `<!DOCTYPE html><html lang="${this.language}"><head><meta charset="utf-8"/>`,
      ...headParts,
      '</head><body id="quire-body" class="', bodyClass, '"><div id="quire-root">', bodyHtml, '</div></body></html>',
    ].join('');

    const prepared: PreparedChapter = { html };
    this.chapterCache.set(spineIndex, prepared);
    return prepared;
  }

  destroy() {
    for (const p of this.blobUrls.values()) {
      p.then((url) => url && URL.revokeObjectURL(url));
    }
    this.blobUrls.clear();
    this.chapterCache.clear();
  }
}
