import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { makeBrowserFetcher, firstLine, type Fetched, type Fetcher } from './browser.js';
import { businessName, demoteRolePrefixes, extractFromDom, looksJsRendered, type EmailSource, type Found } from './extract.js';
import { httpGet } from './http.js';
import { log } from './logger.js';
import { allowed, loadRobots, sitemapsOf, type RobotsRules } from './robots.js';
import { loadSitemapUrls } from './sitemap.js';
import { baseHost, canonical, crawlable, inSection, priority, sameSite, sectionPrefix } from './urls.js';

export { closeBrowser } from './browser.js';
export { setHostConcurrency } from './http.js';

export interface FoundOnPage extends Found {
  link: string; // page the email was found on
  pageTitle?: string; // department page title, set only for section sub-pages
}

export type QueuedPage = [url: string, depth: number];

/**
 * Where a crawl stopped short, so a later run can continue it instead of starting over (resumeSite).
 * Only the HTTP phase is saved page by page; a browser phase that is still owed simply runs again.
 */
export interface ResumeState {
  queued: QueuedPage[]; // HTTP pages still queued when time ran out, best first (at most MAX_SAVED_QUEUE)
  limited: QueuedPage[]; // HTTP pages skipped because the server kept answering 429/503
  seen?: string[]; // canonical URLs already fetched or queued, minus `queued`: never fetched again
  attempts: number; // HTTP page attempts used so far (they count toward --max-pages)
  browser?: 'js-rendered' | 'no-emails'; // the browser phase was wanted but time ran out first (or it ran out itself)
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
  budgetQueued?: number; // pages still queued when the time budget ran out (v3+, or marked from the logs)
  resume?: ResumeState; // v3+: what --retry-budget-queued / --retry-rate-limited continue from
  error?: string; // 'unreachable' | 'robots-disallowed' | 'timeout' | 'browser-error' | 'internal-error'
}

export const CACHE_VERSION = 3;

const MAX_SAVED_QUEUE = 2000; // queued pages kept per site; ones past it can still be found again through links

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

/** `onRateLimited` gets the URL that was asked for, not the redirect hop that answered 429/503. */
function httpFetcher(signal?: AbortSignal, onRateLimited?: (url: string) => void): Fetcher {
  return async (url) => {
    const r = await httpGet(url, { types: PAGE_TYPES, signal, onRateLimited: () => onRateLimited?.(url) });
    if (!r || r.status < 200 || r.status >= 300 || !r.body) return null;
    return { html: r.body, url: r.url };
  };
}

// ---------------- Crawl ----------------

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

/** One site's crawl in progress: robots rules, what has been seen and queued, and the emails found. */
class SiteCrawl {
  readonly emails = new Map<string, EmailHit>();
  readonly seen = new Set<string>();
  readonly queue = new PageQueue();
  readonly depthOf = new Map<string, number>();
  pages = 0; // successful fetches
  attempts = 0;
  section: string | null = null;
  landingKey = '';

  constructor(readonly host: string, readonly robots: RobotsRules, private readonly maxDepth: number) {}

  /** `again` re-queues a saved page, which is already in `seen`. */
  enqueue(u: URL, depth: number, again = false): void {
    if (this.maxDepth && depth > this.maxDepth) return;
    if (!crawlable(u, this.host)) return;
    const key = canonical(u);
    if (this.seen.has(key) && !again) return;
    if (!allowed(this.robots, u.toString())) return;
    this.seen.add(key);
    this.queue.push(u.toString(), priority(u, depth, this.section));
    this.depthOf.set(u.toString(), depth);
  }

  /** Records the page's emails and returns its links. Parses the page once. */
  ingest(html: string, link: string): URL[] {
    const $ = cheerio.load(html);
    const links = collectLinks($, link);
    const u = new URL(link);
    const title = this.section && inSection(u, this.section) && canonical(u) !== this.landingKey ? pageTitleOf($) : undefined;
    for (const f of extractFromDom($, html)) merge(this.emails, f.email, { name: f.name, link, pageTitle: title, source: f.source, nameFrom: f.nameFrom });
    return links;
  }
}

interface CrawlOut {
  emails: Map<string, EmailHit>;
  pages: number; // successful fetches
  home: Fetched | null;
  blocked?: boolean; // landing page disallowed by robots.txt
  state?: SiteCrawl; // set once the landing page loaded
  outOfTime?: boolean; // stopped by the deadline or the abort signal with pages still queued
}

interface RunLimits { deadline?: number; concurrency?: number; signal?: AbortSignal }

/** Fetches queued pages until the queue is empty or the attempt cap is hit; true if time ran out first. */
async function runQueue(c: SiteCrawl, fetcher: Fetcher, maxPages: number, opts: RunLimits): Promise<boolean> {
  const stopped = () => !!opts.signal?.aborted || (!!opts.deadline && Date.now() > opts.deadline);
  let inflight = 0;
  let outOfTime = false;
  const workers = Array.from({ length: opts.concurrency ?? 3 }, async () => {
    for (;;) {
      if (stopped()) { outOfTime = true; return; }
      if (c.attempts >= maxPages) return;
      const item = c.queue.pop();
      if (!item) {
        // other workers may still add links; wait briefly if any are in flight
        if (inflight === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      inflight++;
      c.attempts++;
      try {
        const r = await fetcher(item.url);
        if (!r) {
          // cut off by the hard stop: back into the queue, so it is saved for a later run
          if (opts.signal?.aborted) {
            c.queue.push(item.url, item.pri);
            c.attempts--;
          }
          continue;
        }
        const final = new URL(r.url);
        if (r.url !== item.url) {
          // a redirect: don't fetch the target again, and don't take emails from another site or a disallowed page
          c.seen.add(canonical(final));
          if (!sameSite(final, c.host) || !allowed(c.robots, r.url)) {
            log.debug({ url: item.url, to: r.url }, 'skipping a redirect off the site or into a disallowed path');
            continue;
          }
        }
        c.pages++;
        const d = (c.depthOf.get(item.url) ?? 1) + 1;
        for (const l of c.ingest(r.html, r.url)) c.enqueue(l, d);
      } catch (err) {
        // one bad page must never take the whole site down
        log.debug({ url: item.url, err }, 'page processing failed');
      } finally {
        inflight--;
      }
    }
  });
  await Promise.all(workers);
  if (outOfTime && c.queue.size) {
    const why = opts.signal?.aborted ? 'stopped at the hard time limit' : 'time budget used up';
    log.info({ pages: c.pages, emails: c.emails.size, queued: c.queue.size }, `${why} after ${c.pages} pages (${c.queue.size} still queued); keeping the ${c.emails.size} emails found so far; continue with --retry-budget-queued`);
  }
  return outOfTime && c.queue.size > 0;
}

async function crawl(
  start: string,
  fetcher: Fetcher,
  maxPages: number,
  opts: RunLimits & { useSitemap?: boolean; maxDepth?: number },
): Promise<CrawlOut> {
  const none = new Map<string, EmailHit>();
  let robots = await loadRobots(new URL(start).origin);
  const stopped = () => !!opts.signal?.aborted || (!!opts.deadline && Date.now() > opts.deadline);

  if (!allowed(robots, start)) {
    log.info({ url: start }, `robots.txt disallows ${start}`);
    return { emails: none, pages: 0, home: null, blocked: true };
  }

  // homepage first (sequential so we know the final host)
  const first = await fetcher(start);
  if (!first) {
    log.debug({ url: start }, 'start URL unreachable');
    return { emails: none, pages: 0, home: null };
  }
  const landing = new URL(first.url);
  // A redirect to another server means that server's robots.txt applies.
  if (landing.origin !== new URL(start).origin) {
    robots = await loadRobots(landing.origin);
    if (!allowed(robots, first.url)) {
      log.info({ url: first.url, start }, `robots.txt disallows ${first.url} (redirected from ${start})`);
      return { emails: none, pages: 1, home: first, blocked: true };
    }
  }
  const c = new SiteCrawl(landing.hostname, robots, opts.maxDepth ?? 0);
  c.attempts = 1;
  c.pages = 1;
  c.section = sectionPrefix(new URL(start), landing);
  c.landingKey = canonical(landing);
  c.seen.add(c.landingKey);
  c.seen.add(canonical(new URL(start)));

  try {
    for (const l of c.ingest(first.html, first.url)) c.enqueue(l, 1);
  } catch (err) {
    log.debug({ url: first.url, err }, 'page processing failed');
  }
  if (opts.useSitemap && !stopped()) {
    const sm = await loadSitemapUrls(landing.origin, sitemapsOf(robots), { deadline: opts.deadline, signal: opts.signal });
    for (const s of sm) {
      try {
        const u = new URL(s);
        if (!c.section || inSection(u, c.section)) c.enqueue(u, 1);
      } catch { /* ignore */ }
    }
  }

  const outOfTime = await runQueue(c, fetcher, maxPages, opts);
  return { emails: c.emails, pages: c.pages, home: first, state: c, outOfTime };
}

interface Leftover {
  queued: QueuedPage[];
  total: number; // queued pages before the MAX_SAVED_QUEUE cap
  limited: QueuedPage[];
  seen?: string[];
}

/**
 * What an HTTP crawl leaves for a later run: its queue if time ran out (drained best first), the pages the
 * server rate-limited, plus `carry` (saved parts a resume didn't work on), and everything else it saw.
 */
function leftover(c: SiteCrawl, outOfTime: boolean, limitedUrls: Iterable<string>, carry: { queued: QueuedPage[]; limited: QueuedPage[] } = { queued: [], limited: [] }): Leftover {
  const queued: QueuedPage[] = [];
  if (outOfTime) for (let it = c.queue.pop(); it; it = c.queue.pop()) queued.push([it.url, c.depthOf.get(it.url) ?? 1]);
  queued.push(...carry.queued);
  const fresh = [...limitedUrls].filter((u) => c.depthOf.has(u)).map((u): QueuedPage => [u, c.depthOf.get(u)!]);
  const limited = [...new Map([...carry.limited, ...fresh].map((p) => [p[0], p])).values()];
  if (!queued.length && !limited.length) return { queued, total: 0, limited };
  const pending = new Set<string>();
  for (const [u] of queued) {
    try { pending.add(canonical(new URL(u))); } catch { /* ignore */ }
  }
  return { queued: queued.slice(0, MAX_SAVED_QUEUE), total: queued.length, limited, seen: [...c.seen].filter((k) => !pending.has(k)) };
}

function resumeState(left: Leftover | undefined, attempts: number, browser?: ResumeState['browser']): ResumeState | undefined {
  if (!left?.queued.length && !left?.limited.length && !browser) return undefined;
  const s: ResumeState = { queued: left?.queued ?? [], limited: left?.limited ?? [], attempts };
  if (left?.seen) s.seen = left.seen;
  if (browser) s.browser = browser;
  return s;
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

/** Phase 2: the first start that loads, crawled with the headless browser. Throws if the browser fails. */
async function browserPhase(starts: string[], opt: CrawlOptions, deadline: number, signal?: AbortSignal): Promise<CrawlOut | null> {
  const { fetcher, close } = makeBrowserFetcher(signal);
  try {
    let out: CrawlOut | null = null;
    for (const start of starts) {
      if (signal?.aborted) break;
      out = await crawl(start, fetcher, opt.browserPages, { concurrency: 2, deadline, maxDepth: opt.maxDepth, signal });
      if (out.blocked || out.home) break;
    }
    return out;
  } finally {
    await close();
  }
}

const toHit = (e: FoundOnPage): EmailHit => ({ name: e.name, link: e.link, pageTitle: e.pageTitle, source: e.source, nameFrom: e.nameFrom });
const toFound = ([email, h]: [string, EmailHit]): FoundOnPage => ({ email, name: h.name, link: h.link, pageTitle: h.pageTitle, source: h.source, nameFrom: h.nameFrom });

/**
 * Crawls one site: plain HTTP first, then a headless browser when the site couldn't be loaded, looks
 * JS-rendered or gave no emails. Aborting `signal` (the hard timeout) stops it and returns what was found.
 * When time runs out or the server rate-limits pages, `resume` records what is left for resumeSite().
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
  const limited = new Set<string>();
  const fetchHttp = httpFetcher(signal, (url) => { rateLimited++; limited.add(url); });
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
  const left = httpOut?.state ? leftover(httpOut.state, !!httpOut.outOfTime, limited) : undefined;
  if (left?.total) result.budgetQueued = left.total;

  // --- Phase 2: headless browser fallback ---
  const jsRendered = !httpOut?.home || looksJsRendered(httpOut.home.html);
  const wantBrowser = opt.browserPages > 0 && (jsRendered || all.size === 0);
  let browserOwed: ResumeState['browser'];
  if (wantBrowser && !signal?.aborted && Date.now() < deadline) {
    try {
      // Start where Phase 1 landed when it got in; otherwise try every variant, http:// included.
      const out = await browserPhase(httpOut?.home ? [httpOut.home.url] : candidateStarts(site), opt, deadline, signal);
      if (out?.blocked) {
        result.error = 'robots-disallowed'; // keep Phase 1's emails
        if (out.home && !httpOut?.home) result.finalUrl = out.home.url;
      } else if (out?.home) {
        result.usedBrowser = true;
        result.pages += out.pages;
        homeHtml ??= out.home.html;
        if (!httpOut?.home) {
          homeHost = new URL(out.home.url).hostname;
          result.finalUrl = out.home.url;
        }
        for (const [e, h] of out.emails) merge(all, e, h);
        if (out.outOfTime) {
          browserOwed = jsRendered ? 'js-rendered' : 'no-emails';
          result.budgetQueued = out.state?.queue.size;
        }
      }
    } catch (err) {
      result.error = 'browser-error';
      log.error({ err }, `headless browser failed on this site${httpOut?.home ? '; kept the plain-HTTP results' : ''}: ${firstLine(err)}`);
    }
  } else if (wantBrowser && httpOut?.home) {
    browserOwed = jsRendered ? 'js-rendered' : 'no-emails';
  }

  if (rateLimited) result.rateLimited = rateLimited;
  const resume = resumeState(left, httpOut?.state?.attempts ?? 0, browserOwed);
  if (resume) result.resume = resume;
  if (signal?.aborted) result.error ??= 'timeout';
  if (!homeHtml) {
    result.error ??= 'unreachable';
    return result;
  }
  result.business = businessName(homeHtml, homeHost);
  result.emails = [...all].map(toFound);
  demoteRolePrefixes(result.emails);
  return result;
}

/** Which saved parts of a ResumeState to work on. */
export interface ResumeParts {
  budget: boolean; // the queue left when time ran out, and a browser phase still owed
  limited: boolean; // the pages the server rate-limited
}

/**
 * Continues an earlier scrapeSite() from its saved `resume` state instead of starting over. Pages fetched
 * before are never fetched again, and new emails are merged into `prev`'s. Parts not selected are carried
 * over unchanged, so they can still be continued later. Returns `prev` when there is nothing to do or
 * robots.txt now disallows the landing page.
 */
export async function resumeSite(prev: SiteResult, parts: ResumeParts, options: Partial<CrawlOptions> = {}, signal?: AbortSignal): Promise<SiteResult> {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const deadline = Date.now() + opt.budgetMs;
  const saved = prev.resume;
  if (!saved) return prev;
  const landing = new URL(prev.finalUrl);
  const robots = await loadRobots(landing.origin);
  if (!allowed(robots, prev.finalUrl)) {
    log.info({ url: prev.finalUrl }, `robots.txt now disallows ${prev.finalUrl}; keeping the earlier result`);
    return prev;
  }

  const c = new SiteCrawl(landing.hostname, robots, opt.maxDepth);
  c.section = sectionPrefix(new URL(prev.site), landing);
  c.landingKey = canonical(landing);
  for (const k of saved.seen ?? []) c.seen.add(k);
  for (const [u] of saved.queued) {
    try { c.seen.add(canonical(new URL(u))); } catch { /* ignore */ }
  }
  let takeQueued = parts.budget && saved.queued.length > 0;
  let takeLimited = parts.limited && saved.limited.length > 0;
  // A rate-limited page's failed attempt is given back when it is tried again.
  if ((takeQueued || takeLimited) && saved.attempts - (takeLimited ? saved.limited.length : 0) >= opt.maxPages) {
    log.info({ attempts: saved.attempts, maxPages: opt.maxPages }, `the page cap is used up (${saved.attempts} of --max-pages=${opt.maxPages}); raise --max-pages to continue this site`);
    takeQueued = takeLimited = false;
  }
  c.attempts = saved.attempts - (takeLimited ? saved.limited.length : 0);
  const requeue = (pages: QueuedPage[]) => {
    for (const [u, d] of pages) {
      try { c.enqueue(new URL(u), d, true); } catch { /* ignore */ }
    }
  };
  if (takeQueued) requeue(saved.queued);
  if (takeLimited) requeue(saved.limited);

  let rateLimited = 0;
  const limited = new Set<string>();
  let outOfTime = false;
  if (c.queue.size) {
    const fetchHttp = httpFetcher(signal, (url) => { rateLimited++; limited.add(url); });
    outOfTime = await runQueue(c, fetchHttp, opt.maxPages, { deadline, concurrency: opt.pageConcurrency, signal });
  }
  const left = leftover(c, outOfTime, limited, { queued: takeQueued ? [] : saved.queued, limited: takeLimited ? [] : saved.limited });

  const all = new Map(prev.emails.map((e) => [e.email, toHit(e)] as const));
  for (const [e, h] of c.emails) merge(all, e, h);
  let pages = prev.pages + c.pages;
  let usedBrowser = prev.usedBrowser;
  let error = prev.error === 'timeout' ? undefined : prev.error;
  let browserQueued = 0;
  let owed = saved.browser === 'no-emails' && all.size ? undefined : saved.browser;
  if (parts.budget && owed && opt.browserPages > 0 && !outOfTime && !signal?.aborted && Date.now() < deadline) {
    try {
      const out = await browserPhase([prev.finalUrl], opt, deadline, signal);
      owed = undefined;
      if (error === 'browser-error') error = undefined;
      if (out?.blocked) {
        error = 'robots-disallowed';
      } else if (out?.home) {
        usedBrowser = true;
        pages += out.pages;
        for (const [e, h] of out.emails) merge(all, e, h);
        if (out.outOfTime) {
          owed = saved.browser;
          browserQueued = out.state?.queue.size ?? 0;
        }
      }
    } catch (err) {
      error = 'browser-error';
      log.error({ err }, `headless browser failed on this site; kept the earlier results: ${firstLine(err)}`);
    }
  }

  const result: SiteResult = { v: CACHE_VERSION, site: prev.site, finalUrl: prev.finalUrl, business: prev.business, emails: [...all].map(toFound), pages, usedBrowser };
  const limitedTotal = (takeLimited ? 0 : prev.rateLimited ?? 0) + rateLimited;
  if (limitedTotal) result.rateLimited = limitedTotal;
  // An informational count: pages still queued, whether carried over or left by this pass.
  const carried = takeQueued ? 0 : saved.queued.length ? prev.budgetQueued ?? saved.queued.length : 0;
  const queued = left.total - (takeQueued ? 0 : saved.queued.length) + carried + browserQueued;
  if (queued > 0) result.budgetQueued = queued;
  const resume = resumeState(left, c.attempts, owed);
  if (resume) result.resume = resume;
  if (signal?.aborted) error ??= 'timeout';
  if (error) result.error = error;
  demoteRolePrefixes(result.emails);
  return result;
}
