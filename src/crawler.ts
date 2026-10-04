import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { makeBrowserFetcher, firstLine, type Fetched, type Fetcher } from './browser.js';
import { businessName, demoteRolePrefixes, extractFromDom, looksJsRendered, type EmailSource, type Found } from './extract.js';
import { httpGet } from './http.js';
import { log } from './logger.js';
import { allowed, loadRobots, sitemapsOf } from './robots.js';
import { loadSitemapUrls } from './sitemap.js';
import { baseHost, canonical, crawlable, inSection, priority, sameSite, sectionPrefix } from './urls.js';

export { closeBrowser } from './browser.js';
export { setHostConcurrency } from './http.js';

export interface FoundOnPage extends Found {
  link: string; // page the email was found on
  pageTitle?: string; // department page title, set only for section sub-pages
}

export interface SiteResult {
  v?: number; // cache line schema version; absent on lines written before v2
  site: string;
  finalUrl: string; // homepage URL after redirects
  business: string;
  emails: FoundOnPage[];
  pages: number; // pages fetched successfully
  usedBrowser: boolean;
  rateLimited?: number; // pages skipped because the server kept answering 429/503
  error?: string; // 'unreachable' | 'robots-disallowed' | 'timeout' | 'browser-error' | 'internal-error'
}

export const CACHE_VERSION = 2;

type EmailHit = { name: string | null; link: string; pageTitle?: string; source?: EmailSource; nameFrom?: Found['nameFrom'] };

/** Keep the first page an email was seen on, but upgrade to a page that ties it to a person name. */
function merge(into: Map<string, EmailHit>, email: string, hit: EmailHit): void {
  const prev = into.get(email);
  if (prev === undefined || (prev.name === null && hit.name)) into.set(email, hit);
}

/** Department name for a section sub-page: its <h1>, else the first segment of <title>. */
function pageTitleOf($: CheerioAPI): string | undefined {
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  const h1 = clean($('h1').first().text());
  if (h1 && h1.length <= 100) return h1;
  const title = clean($('title').first().text()).split(/\s+[|–—]\s+|\s+-\s+/)[0]?.trim();
  return title && title.length <= 100 ? title : undefined;
}

/** Per-site crawl limits. Depth is click-levels from the landing page (level 0); 0 means unlimited. */
export interface CrawlOptions {
  maxPages: number; // plain-HTTP page attempts (phase 1)
  browserPages: number; // headless-browser page attempts (phase 2)
  maxDepth: number;
  budgetMs: number; // soft budget; partial results are kept when it runs out
  pageConcurrency: number; // parallel page requests within one site (HTTP phase)
}

export const DEFAULT_OPTIONS: CrawlOptions = { maxPages: 400, browserPages: 60, maxDepth: 0, budgetMs: 20 * 60_000, pageConcurrency: 3 };
export const QUICK_OPTIONS: CrawlOptions = { maxPages: 150, browserPages: 30, maxDepth: 0, budgetMs: 10 * 60_000, pageConcurrency: 3 };

const PAGE_TYPES = /html|xml|text\/plain/i;

function httpFetcher(signal?: AbortSignal, onRateLimited?: () => void): Fetcher {
  return async (url) => {
    const r = await httpGet(url, { types: PAGE_TYPES, signal, onRateLimited });
    if (!r || r.status < 200 || r.status >= 300 || !r.body) return null;
    return { html: r.body, url: r.url };
  };
}

// ---------------- Crawl ----------------

interface CrawlOut {
  emails: Map<string, EmailHit>;
  pages: number; // successful fetches
  home: Fetched | null;
  blocked?: boolean; // landing page disallowed by robots.txt
}

function collectLinks($: CheerioAPI, pageUrl: string): URL[] {
  const out: URL[] = [];
  const base = $('base[href]').attr('href');
  let baseUrl: URL | string = pageUrl;
  try {
    if (base) baseUrl = new URL(base, pageUrl);
  } catch { /* invalid <base> */ }
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') ?? '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#|sms:|data:)/i.test(href)) return;
    try {
      out.push(new URL(href, baseUrl));
    } catch { /* ignore */ }
  });
  return out;
}

type QueueItem = { url: string; pri: number; seq: number };

/** Min-heap by priority, then insertion order (so equal priorities stay first-in, first-out). */
class PageQueue {
  private heap: QueueItem[] = [];
  private seq = 0;
  get size(): number { return this.heap.length; }
  private less(a: QueueItem, b: QueueItem): boolean { return a.pri < b.pri || (a.pri === b.pri && a.seq < b.seq); }
  push(url: string, pri: number): void {
    const h = this.heap;
    h.push({ url, pri, seq: this.seq++ });
    for (let i = h.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop(): QueueItem | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
}

async function crawl(
  start: string,
  fetcher: Fetcher,
  maxPages: number,
  opts: { deadline?: number; useSitemap?: boolean; concurrency?: number; maxDepth?: number; signal?: AbortSignal },
): Promise<CrawlOut> {
  const emails = new Map<string, EmailHit>();
  const seen = new Set<string>();
  const queue = new PageQueue();
  let pages = 0;
  let attempts = 0;
  let host = new URL(start).hostname;
  let robots = await loadRobots(new URL(start).origin);
  let section: string | null = null;
  let landingKey = '';
  const stopped = () => !!opts.signal?.aborted || (!!opts.deadline && Date.now() > opts.deadline);

  if (!allowed(robots, start)) {
    log.info({ url: start }, `robots.txt disallows ${start}`);
    return { emails, pages: 0, home: null, blocked: true };
  }

  const depthOf = new Map<string, number>();
  const enqueue = (u: URL, depth: number) => {
    if (opts.maxDepth && depth > opts.maxDepth) return;
    if (!crawlable(u, host)) return;
    const key = canonical(u);
    if (seen.has(key)) return;
    if (!allowed(robots, u.toString())) return;
    seen.add(key);
    queue.push(u.toString(), priority(u, depth, section));
    depthOf.set(u.toString(), depth);
  };

  // homepage first (sequential so we know the final host)
  const first = await fetcher(start);
  attempts++;
  if (!first) {
    log.debug({ url: start }, 'start URL unreachable');
    return { emails, pages: 0, home: null };
  }
  pages++;
  const landing = new URL(first.url);
  host = landing.hostname;
  // A redirect to another server means that server's robots.txt applies.
  if (landing.origin !== new URL(start).origin) {
    robots = await loadRobots(landing.origin);
    if (!allowed(robots, first.url)) {
      log.info({ url: first.url, start }, `robots.txt disallows ${first.url} (redirected from ${start})`);
      return { emails, pages, home: first, blocked: true };
    }
  }
  section = sectionPrefix(new URL(start), landing);
  landingKey = canonical(landing);
  seen.add(landingKey);
  seen.add(canonical(new URL(start)));

  /** Records the page's emails and returns its links. Parses the page once. */
  const ingest = (html: string, link: string): URL[] => {
    const $ = cheerio.load(html);
    const links = collectLinks($, link);
    const u = new URL(link);
    const title = section && inSection(u, section) && canonical(u) !== landingKey ? pageTitleOf($) : undefined;
    for (const f of extractFromDom($, html)) merge(emails, f.email, { name: f.name, link, pageTitle: title, source: f.source, nameFrom: f.nameFrom });
    return links;
  };
  try {
    for (const l of ingest(first.html, first.url)) enqueue(l, 1);
  } catch (err) {
    log.debug({ url: first.url, err }, 'page processing failed');
  }
  if (opts.useSitemap && !stopped()) {
    const sm = await loadSitemapUrls(landing.origin, sitemapsOf(robots), { deadline: opts.deadline, signal: opts.signal });
    for (const s of sm) {
      try {
        const u = new URL(s);
        if (!section || inSection(u, section)) enqueue(u, 1);
      } catch { /* ignore */ }
    }
  }

  let inflight = 0;
  let outOfTime = false;
  const workers = Array.from({ length: opts.concurrency ?? 3 }, async () => {
    for (;;) {
      if (stopped()) { outOfTime = true; return; }
      if (attempts >= maxPages) return;
      const item = queue.pop();
      if (!item) {
        // other workers may still add links; wait briefly if any are in flight
        if (inflight === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      inflight++;
      attempts++;
      try {
        const r = await fetcher(item.url);
        if (!r) continue;
        const final = new URL(r.url);
        if (r.url !== item.url) {
          // a redirect: don't fetch the target again, and don't take emails from another site or a disallowed page
          seen.add(canonical(final));
          if (!sameSite(final, host) || !allowed(robots, r.url)) {
            log.debug({ url: item.url, to: r.url }, 'skipping a redirect off the site or into a disallowed path');
            continue;
          }
        }
        pages++;
        const d = (depthOf.get(item.url) ?? 1) + 1;
        for (const l of ingest(r.html, r.url)) enqueue(l, d);
      } catch (err) {
        // one bad page must never take the whole site down
        log.debug({ url: item.url, err }, 'page processing failed');
      } finally {
        inflight--;
      }
    }
  });
  await Promise.all(workers);
  if (outOfTime) {
    const why = opts.signal?.aborted ? 'stopped at the hard time limit' : 'time budget used up';
    log.info({ pages, emails: emails.size, queued: queue.size }, `${why} after ${pages} pages (${queue.size} still queued); keeping the ${emails.size} emails found so far`);
  }
  return { emails, pages, home: first };
}

/** Start URLs to try: the input, its http:// form, and the www./bare-domain variant. */
function candidateStarts(site: string): string[] {
  const u = new URL(site);
  const list = [u.toString()];
  const http = new URL(u); http.protocol = 'http:';
  list.push(http.toString());
  const alt = new URL(u);
  alt.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
  if (alt.hostname.includes('.')) list.push(alt.toString());
  return [...new Set(list)];
}

/**
 * Crawls one site: plain HTTP first, then a headless browser when the site couldn't be loaded, looks
 * JS-rendered or gave no emails. Aborting `signal` (the hard timeout) stops it and returns what was found.
 */
export async function scrapeSite(site: string, options: Partial<CrawlOptions> = {}, signal?: AbortSignal): Promise<SiteResult> {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const deadline = Date.now() + opt.budgetMs;
  const result: SiteResult = {
    v: CACHE_VERSION,
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
  let rateLimited = 0;
  const fetchHttp = httpFetcher(signal, () => { rateLimited++; });
  for (const start of candidateStarts(site)) {
    if (signal?.aborted) break;
    const out = await crawl(start, fetchHttp, opt.maxPages, { useSitemap: true, deadline, maxDepth: opt.maxDepth, concurrency: opt.pageConcurrency, signal });
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
  const needBrowser = !signal?.aborted && Date.now() < deadline && opt.browserPages > 0
    && (!httpOut?.home || looksJsRendered(httpOut.home.html) || all.size === 0);
  if (needBrowser) {
    const { fetcher, close } = makeBrowserFetcher(signal);
    try {
      // Start where Phase 1 landed when it got in; otherwise try every variant, http:// included.
      const starts = httpOut?.home ? [httpOut.home.url] : candidateStarts(site);
      let out: CrawlOut | null = null;
      for (const start of starts) {
        if (signal?.aborted) break;
        out = await crawl(start, fetcher, opt.browserPages, { concurrency: 2, deadline, maxDepth: opt.maxDepth, signal });
        if (out.blocked) {
          result.error = 'robots-disallowed';
          if (out.home && !httpOut?.home) result.finalUrl = out.home.url;
          out = null;
          break; // keep Phase 1's emails
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
    } catch (err) {
      result.error = 'browser-error';
      log.error({ err }, `headless browser failed on this site${httpOut?.home ? '; kept the plain-HTTP results' : ''}: ${firstLine(err)}`);
    } finally {
      await close();
    }
  }

  if (rateLimited) result.rateLimited = rateLimited;
  if (signal?.aborted) result.error ??= 'timeout';
  if (!homeHtml) {
    result.error ??= 'unreachable';
    return result;
  }
  result.business = businessName(homeHtml, homeHost);
  result.emails = [...all].map(([email, h]) => ({ email, name: h.name, link: h.link, pageTitle: h.pageTitle, source: h.source, nameFrom: h.nameFrom }));
  demoteRolePrefixes(result.emails);
  return result;
}
