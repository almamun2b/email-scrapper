import * as cheerio from 'cheerio';
import robotsModule from 'robots-parser';
import { chromium, type Browser } from 'playwright';
import pLimit from 'p-limit';
import { baseHost, canonical, crawlable, inSection, priority, sectionPrefix } from './urls.js';
import { businessName, extractFromHtml, looksJsRendered, type Found } from './extract.js';

export interface FoundOnPage extends Found {
  link: string; // page the email was found on
  pageTitle?: string; // department page title, set only for section sub-pages
}

type EmailHit = { name: string | null; link: string; pageTitle?: string };

/** Keep the first page an email was seen on, but upgrade to a page that ties it to a person name. */
function merge(into: Map<string, EmailHit>, email: string, hit: EmailHit): void {
  const prev = into.get(email);
  if (prev === undefined || (prev.name === null && hit.name)) into.set(email, hit);
}

/** Department name for a section sub-page: its <h1>, else the first segment of <title>. */
function pageTitleOf(html: string): string | undefined {
  const $ = cheerio.load(html);
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  const h1 = clean($('h1').first().text());
  if (h1 && h1.length <= 100) return h1;
  const title = clean($('title').first().text()).split(/\s+[|–—]\s+|\s+-\s+/)[0]?.trim();
  return title && title.length <= 100 ? title : undefined;
}

export interface SiteResult {
  site: string;
  finalUrl: string; // homepage URL after redirects
  business: string;
  emails: FoundOnPage[];
  pages: number;
  usedBrowser: boolean;
  error?: string;
}

interface Robots {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getSitemaps(): string[];
}
const robotsParser = ((robotsModule as any).default ?? robotsModule) as (url: string, txt: string) => Robots;

const robotsCache = new Map<string, Promise<Robots | undefined>>();

/** robots.txt for an origin (cached for the whole run); undefined when the site has none. */
function loadRobots(origin: string): Promise<Robots | undefined> {
  let p = robotsCache.get(origin);
  if (!p) {
    p = httpGet(origin + '/robots.txt', 'text/plain,*/*').then((r) =>
      r && /user-agent/i.test(r.body) && !/<html/i.test(r.body) ? robotsParser(origin + '/robots.txt', r.body) : undefined,
    );
    robotsCache.set(origin, p);
  }
  return p;
}

const allowed = (robots: Robots | undefined, url: string) => robots?.isAllowed(url, UA) !== false;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_PAGES = 150;
const BROWSER_MAX_PAGES = 30;
const HTTP_TIMEOUT = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const PAGE_CONCURRENCY = 3;

interface Fetched {
  html: string;
  url: string; // final URL after redirects
}
type Fetcher = (url: string) => Promise<Fetched | null>;

// ---------------- HTTP ----------------

// Caps concurrent requests to one server across all sites crawled in parallel
// (many input domains can redirect to the same host).
const HOST_CONCURRENCY = 3;
const hostLimits = new Map<string, ReturnType<typeof pLimit>>();

function hostLimit(url: string): ReturnType<typeof pLimit> {
  const host = baseHost(new URL(url).hostname);
  let l = hostLimits.get(host);
  if (!l) hostLimits.set(host, (l = pLimit(HOST_CONCURRENCY)));
  return l;
}

type HttpResult = { body: string; url: string; type: string };

async function httpGet(url: string, accept = 'text/html,application/xhtml+xml,*/*;q=0.8'): Promise<HttpResult | null> {
  const first = await hostLimit(url)(() => httpGetOnce(url, accept));
  if (first !== 'retry') return first;
  await new Promise((r) => setTimeout(r, 3_000));
  const second = await hostLimit(url)(() => httpGetOnce(url, accept));
  return second === 'retry' ? null : second;
}

/** 'retry' for rate limiting (429/503) and network errors, null for other failures. */
async function httpGetOnce(url: string, accept: string): Promise<HttpResult | null | 'retry'> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept, 'accept-language': 'en-NZ,en;q=0.9' },
    });
    if (res.status === 429 || res.status === 503) return 'retry';
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total > MAX_BYTES) { ctl.abort(); break; }
    }
    return { body: Buffer.concat(chunks).toString('utf8'), url: res.url || url, type };
  } catch {
    return ctl.signal.aborted ? null : 'retry';
  } finally {
    clearTimeout(timer);
  }
}

const httpFetcher: Fetcher = async (url) => {
  const r = await httpGet(url);
  if (!r) return null;
  if (r.type && !/html|xml|text\/plain/i.test(r.type)) return null;
  return { html: r.body, url: r.url };
};

// ---------------- Browser ----------------

let browserPromise: Promise<Browser> | null = null;
const browserLimit = pLimit(4);

function getBrowser(): Promise<Browser> {
  browserPromise ??= chromium.launch({ headless: true });
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    await b?.close().catch(() => {});
    browserPromise = null;
  }
}

function makeBrowserFetcher(): { fetcher: Fetcher; close: () => Promise<void> } {
  let ctxPromise: Promise<import('playwright').BrowserContext> | null = null;
  const ctx = () => {
    ctxPromise ??= getBrowser().then((b) =>
      b.newContext({ userAgent: UA, locale: 'en-NZ', ignoreHTTPSErrors: true }),
    );
    return ctxPromise;
  };
  const fetcher: Fetcher = (url) =>
    browserLimit(async () => {
      const c = await ctx();
      const page = await c.newPage();
      try {
        await page.route('**/*', (route) => {
          const t = route.request().resourceType();
          if (t === 'image' || t === 'media' || t === 'font') return route.abort();
          return route.continue();
        });
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        if (!resp) return null;
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
        const html = await page.content();
        return { html, url: page.url() };
      } catch {
        return null;
      } finally {
        await page.close().catch(() => {});
      }
    });
  const close = async () => {
    if (ctxPromise) (await ctxPromise.catch(() => null))?.close().catch(() => {});
  };
  return { fetcher, close };
}

// ---------------- Crawl ----------------

interface CrawlOut {
  emails: Map<string, EmailHit>;
  pages: number;
  home: Fetched | null;
  blocked?: boolean; // landing page disallowed by robots.txt
}

function collectLinks(html: string, pageUrl: string): URL[] {
  const $ = cheerio.load(html);
  const out: URL[] = [];
  const base = $('base[href]').attr('href');
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#|sms:|data:)/i.test(href)) return;
    try {
      out.push(new URL(href, base ? new URL(base, pageUrl) : pageUrl));
    } catch { /* ignore */ }
  });
  return out;
}

async function loadSitemapUrls(origin: string, robotsSitemaps: string[]): Promise<string[]> {
  const queue = [...new Set([...robotsSitemaps, origin + '/sitemap.xml', origin + '/sitemap_index.xml'])];
  const seen = new Set<string>();
  const urls: string[] = [];
  let fetched = 0;
  while (queue.length && fetched < 8 && urls.length < 2000) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const r = await httpGet(sm, 'application/xml,text/xml,*/*');
    fetched++;
    if (!r || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    const locs = [...r.body.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]);
    for (const l of locs) {
      if (/\.xml(\.gz)?$/i.test(l) || /sitemap/i.test(l)) queue.push(l);
      else urls.push(l);
    }
  }
  return urls;
}

async function crawl(
  start: string,
  fetcher: Fetcher,
  maxPages: number,
  opts: { deadline?: number; useSitemap?: boolean; concurrency?: number },
): Promise<CrawlOut> {
  const emails = new Map<string, EmailHit>();
  const seen = new Set<string>();
  const queue: { url: string; pri: number }[] = [];
  let pages = 0;
  let host = new URL(start).hostname;
  let robots = await loadRobots(new URL(start).origin);
  let section: string | null = null;
  let landingKey = '';

  if (!allowed(robots, start)) return { emails, pages: 0, home: null, blocked: true };

  const enqueue = (u: URL, depth: number) => {
    if (!crawlable(u, host)) return;
    const key = canonical(u);
    if (seen.has(key)) return;
    if (!allowed(robots, u.toString())) return;
    seen.add(key);
    queue.push({ url: u.toString(), pri: priority(u, depth, section) });
  };

  // homepage first (sequential so we know the final host)
  const first = await fetcher(start);
  if (!first) return { emails, pages: 0, home: null };
  pages++;
  const landing = new URL(first.url);
  host = landing.hostname;
  // A redirect to another server means that server's robots.txt applies.
  if (landing.origin !== new URL(start).origin) {
    robots = await loadRobots(landing.origin);
    if (!allowed(robots, first.url)) return { emails, pages, home: first, blocked: true };
  }
  section = sectionPrefix(new URL(start), landing);
  landingKey = canonical(landing);
  seen.add(landingKey);
  seen.add(canonical(new URL(start)));

  const ingest = (html: string, link: string) => {
    const found = extractFromHtml(html);
    if (!found.length) return;
    const u = new URL(link);
    const title = section && inSection(u, section) && canonical(u) !== landingKey ? pageTitleOf(html) : undefined;
    for (const f of found) merge(emails, f.email, { name: f.name, link, pageTitle: title });
  };
  ingest(first.html, first.url);
  for (const l of collectLinks(first.html, first.url)) enqueue(l, 1);
  if (opts.useSitemap) {
    const sm = await loadSitemapUrls(landing.origin, robots?.getSitemaps() ?? []).catch(() => []);
    for (const s of sm) {
      try {
        const u = new URL(s);
        if (!section || inSection(u, section)) enqueue(u, 1);
      } catch { /* ignore */ }
    }
  }

  const depthOf = new Map<string, number>();
  let inflight = 0;
  const workers = Array.from({ length: opts.concurrency ?? PAGE_CONCURRENCY }, async () => {
    for (;;) {
      if (pages >= maxPages || (opts.deadline && Date.now() > opts.deadline)) return;
      queue.sort((a, b) => a.pri - b.pri);
      const item = queue.shift();
      if (!item) {
        // other workers may still add links; wait briefly if any are in flight
        if (inflight === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      inflight++;
      pages++;
      try {
        const r = await fetcher(item.url);
        if (!r) continue;
        ingest(r.html, r.url);
        const d = (depthOf.get(item.url) ?? 1) + 1;
        for (const l of collectLinks(r.html, r.url)) {
          const before = queue.length;
          enqueue(l, d);
          if (queue.length > before) depthOf.set(l.toString(), d);
        }
      } finally {
        inflight--;
      }
    }
  });
  await Promise.all(workers);
  return { emails, pages, home: first };
}

function candidateStarts(site: string): string[] {
  const u = new URL(site);
  const list = [u.toString()];
  const http = new URL(u); http.protocol = 'http:';
  list.push(http.toString());
  if (!u.hostname.startsWith('www.')) {
    const w = new URL(u); w.hostname = 'www.' + u.hostname;
    list.push(w.toString());
  }
  return [...new Set(list)];
}

export async function scrapeSite(site: string, budgetMs = 10 * 60_000): Promise<SiteResult> {
  const deadline = Date.now() + budgetMs;
  const result: SiteResult = {
    site,
    finalUrl: site,
    business: baseHost(new URL(site).hostname),
    emails: [],
    pages: 0,
    usedBrowser: false,
  };
  const all = new Map<string, EmailHit>();
  let homeHtml: string | null = null;
  let homeHost = new URL(site).hostname;

  // --- Phase 1: plain HTTP ---
  let httpOut: CrawlOut | null = null;
  for (const start of candidateStarts(site)) {
    const out = await crawl(start, httpFetcher, MAX_PAGES, { useSitemap: true, deadline });
    if (out.blocked) {
      result.error = 'robots-disallowed';
      if (out.home) result.finalUrl = out.home.url;
      return result;
    }
    if (out.home) { httpOut = out; break; }
  }
  if (httpOut?.home) {
    homeHtml = httpOut.home.html;
    homeHost = new URL(httpOut.home.url).hostname;
    result.finalUrl = httpOut.home.url;
    result.pages += httpOut.pages;
    for (const [e, h] of httpOut.emails) all.set(e, h);
  }

  // --- Phase 2: headless browser fallback ---
  const needBrowser = Date.now() < deadline && (!httpOut?.home || looksJsRendered(httpOut.home.html) || all.size === 0);
  if (needBrowser) {
    const { fetcher, close } = makeBrowserFetcher();
    try {
      let out: CrawlOut | null = null;
      for (const start of candidateStarts(site).filter((s) => s.startsWith('https:'))) {
        out = await crawl(start, fetcher, BROWSER_MAX_PAGES, { concurrency: 2, deadline });
        if (out.blocked) {
          result.error = 'robots-disallowed';
          if (out.home) result.finalUrl = out.home.url;
          return result;
        }
        if (out.home) break;
      }
      if (out?.home) {
        result.usedBrowser = true;
        result.pages += out.pages;
        homeHtml ??= out.home.html;
        if (!httpOut?.home) {
          homeHost = new URL(out.home.url).hostname;
          result.finalUrl = out.home.url;
        }
        for (const [e, h] of out.emails) merge(all, e, h);
      }
    } catch (e) {
      result.error = String((e as Error).message ?? e);
    } finally {
      await close();
    }
  }

  if (!homeHtml) {
    result.error ??= 'unreachable';
    return result;
  }
  result.business = businessName(homeHtml, homeHost);
  result.emails = [...all].map(([email, h]) => ({ email, name: h.name, link: h.link, pageTitle: h.pageTitle }));
  return result;
}
