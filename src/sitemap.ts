import zlib from 'node:zlib';
import { httpGet } from './http.js';
import { log } from './logger.js';

const LISTING_SITEMAP = /(stock|inventory|vehicle|listing|product|used|new-car|demo)/i;

function bodyText(body: string, bytes: Buffer): string {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return zlib.gunzipSync(bytes, { maxOutputLength: 50 * 1024 * 1024 }).toString('utf8');
    } catch {
      return '';
    }
  }
  return body;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `<loc>` text with XML escapes undone ("?a=1&amp;b=2" is "?a=1&b=2"). */
function xmlText(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d{1,6}|#x[0-9a-f]{1,6});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()];
  });
}

/** Page URLs from a site's sitemaps (robots.txt ones first, then the usual paths). Stops at the deadline. */
export async function loadSitemapUrls(
  origin: string,
  robotsSitemaps: string[],
  opts: { deadline?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
  const queue = [...new Set([...robotsSitemaps, origin + '/sitemap.xml', origin + '/sitemap_index.xml'])];
  const seen = new Set<string>();
  const urls: string[] = [];
  let fetched = 0;
  while (queue.length && fetched < 8 && urls.length < 2000) {
    if (opts.signal?.aborted || (opts.deadline && Date.now() > opts.deadline)) break;
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    try {
      new URL(sm); // a bad <loc> skips that one sitemap, not all of them
      const r = await httpGet(sm, { accept: 'application/xml,text/xml,*/*', signal: opts.signal });
      fetched++;
      if (!r || r.status >= 400) continue;
      const xml = bodyText(r.body, r.bytes);
      const root = /<(urlset|sitemapindex)\b/i.exec(xml)?.[1].toLowerCase();
      if (!root) continue;
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => xmlText(m[1]));
      // A sitemap index lists sitemaps and a urlset lists pages, whatever their URLs look like.
      if (root === 'sitemapindex') queue.push(...locs);
      else urls.push(...locs);
    } catch (err) {
      log.debug({ sitemap: sm, err }, 'sitemap skipped');
    }
    // Stock/product sitemaps can hold thousands of listings; read page/post sitemaps first.
    queue.sort((a, b) => Number(LISTING_SITEMAP.test(a)) - Number(LISTING_SITEMAP.test(b)));
  }
  return urls;
}
