import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { makeBrowserFetcher, firstLine, type Fetched, type Fetcher, type Validators } from './browser.js';
import { businessName, demoteRolePrefixes, extractFromDom, isGenericTitle, looksJsRendered, type EmailSource, type Found } from './extract.js';
import { httpGet, type FailKind } from './http.js';
import { log } from './logger.js';
import { allowed, blockReason, loadRobots, robotsAllow, sitemapsOf, type RobotsBlock, type RobotsRules } from './robots.js';
import type { Mode, PageRecord, PageStore } from './pages.js';
import { loadSitemapUrls } from './sitemap.js';
import { baseHost, canonical, crawlable, inSection, pageKey, priority, sameSite, sectionPrefix } from './urls.js';

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
  queued: QueuedPage[]; // HTTP pages still queued when time ran out or the page cap was hit, best first (at most MAX_SAVED_QUEUE)
  capped?: boolean; // `queued` was left by the page cap (--max-pages), not the time budget: continued by --retry-capped
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
  pages: number; // pages fetched successfully, plus the ones taken from pages the category had already scraped
  reused?: number; // of `pages`, those another site or an earlier run had already scraped, so none was requested
  usedBrowser: boolean;
  rateLimited?: number; // pages skipped because the server kept answering 429/503
  budgetQueued?: number; // pages still queued when the time budget ran out (v3+, or marked from the logs)
  capQueued?: number; // pages still queued when --max-pages was reached
  resume?: ResumeState; // v3+: what --retry-budget-queued / --retry-rate-limited continue from
  error?: string; // 'unreachable' | 'robots-disallowed' | 'robots-unavailable' | 'timeout' | 'browser-error' | 'internal-error'
  errorDetail?: string; // why the landing page didn't load over plain HTTP: a FailKind or `http-<status>` (cache v3+)
}

export const CACHE_VERSION = 3;

const MAX_SAVED_QUEUE = 2000; // queued pages kept per site; ones past it can still be found again through links

type EmailHit = { name: string | null; link: string; pageTitle?: string; source?: EmailSource; nameFrom?: Found['nameFrom'] };

/** Keep the first page an email was seen on, but upgrade to a page that ties it to a person name. */
function merge(into: Map<string, EmailHit>, email: string, hit: EmailHit): void {
  const prev = into.get(email);
  if (prev === undefined || (prev.name === null && hit.name)) into.set(email, hit);
}

/** Department name for a section sub-page: its <h1>, else the first segment of <title>; never "Contact Us" and the like. */
function pageTitleOf($: CheerioAPI): string | undefined {
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  const ok = (t: string | undefined): t is string => !!t && t.length <= 100 && !isGenericTitle(t);
  const h1 = clean($('h1').first().text());
  if (ok(h1)) return h1;
  const title = clean($('title').first().text()).split(/\s+[|–—]\s+|\s+-\s+/)[0]?.trim();
  return ok(title) ? title : undefined;
}

/** Per-site crawl limits. Depth is click-levels from the landing page (level 0); 0 means unlimited. */
export interface CrawlOptions {
  maxPages: number; // plain-HTTP page attempts (phase 1); 0 = unlimited, the time budget is the limit
  browserPages: number; // headless-browser page attempts (phase 2)
  maxDepth: number;
  budgetMs: number; // soft budget; partial results are kept when it runs out
  pageConcurrency: number; // parallel page requests within one site (HTTP phase)
  pages?: PageStore; // every page this category has fetched: a page already in it is reused instead of requested again
  pagesCutoff?: number; // a stored page older than this (epoch ms) is revalidated; unset = every stored page counts
}

export const DEFAULT_OPTIONS: CrawlOptions = { maxPages: 0, browserPages: 60, maxDepth: 0, budgetMs: 20 * 60_000, pageConcurrency: 3 };
export const QUICK_OPTIONS: CrawlOptions = { maxPages: 150, browserPages: 30, maxDepth: 0, budgetMs: 10 * 60_000, pageConcurrency: 3 };

const PAGE_TYPES = /html|xml|text\/plain/i;

/**
 * `onRateLimited` gets the URL that was asked for, not the redirect hop that answered 429/503. Redirects are
 * followed only where robots.txt allows; a refused hop comes back as `disallowed`, without its page.
 */
function httpFetcher(signal?: AbortSignal, onRateLimited?: (url: string) => void, onFail?: (kind: string) => void): Fetcher {
  return async (url, validators) => {
    const headers: Record<string, string> = {};
    if (validators?.etag) headers['if-none-match'] = validators.etag;
    if (validators?.lastModified) headers['if-modified-since'] = validators.lastModified;
    const r = await httpGet(url, { types: PAGE_TYPES, signal, headers, onRateLimited: () => onRateLimited?.(url), allowHop: robotsAllow, onFail });
    if (r?.disallowed) return { html: '', url: r.url, disallowed: true };
    if (r?.status === 304 && Object.keys(headers).length) return { html: '', url: r.url, notModified: true };
    if (r && (r.status < 200 || r.status >= 300)) onFail?.(`http-${r.status}`);
    else if (r && !r.body) onFail?.('not-html');
    if (r && (r.status === 404 || r.status === 410)) return { html: '', url: r.url, gone: true };
    if (!r || r.status < 200 || r.status >= 300 || !r.body) return null;
    return { html: r.body, url: r.url, etag: r.etag, lastModified: r.lastModified };
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
  const add = (raw: string | undefined) => {
    const href = (raw ?? '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#|sms:|data:|about:)/i.test(href)) return;
    try {
      out.push(new URL(href, baseUrl));
    } catch { /* ignore */ }
  };
  $('a[href], area[href]').each((_, a) => add($(a).attr('href')));
  // Older sites keep their content in frames, or forward with a meta refresh; crawlable() drops other sites' frames.
  $('frame[src], iframe[src]').each((_, f) => add($(f).attr('src')));
  $('meta[http-equiv]').each((_, m) => {
    if (!/^refresh$/i.test($(m).attr('http-equiv') ?? '')) return;
    add(/url\s*=\s*['"]?([^'"\s>]+)/i.exec($(m).attr('content') ?? '')?.[1]);
  });
  return out;
}

/**
 * Everything a page gives, whichever site is crawling it: its emails, its department title and the links worth
 * following (those crawlable() lets through for the page's own host, each page once).
 */
function makeRecord(f: Pick<Fetched, 'html' | 'url' | 'etag' | 'lastModified'>): PageRecord {
  const $ = cheerio.load(f.html);
  const page = new URL(f.url);
  const keys = new Set<string>();
  const links: string[] = [];
  for (const l of collectLinks($, f.url)) {
    if (!crawlable(l, page.hostname)) continue;
    const k = pageKey(l);
    if (keys.has(k)) continue;
    keys.add(k);
    links.push(l.origin === page.origin ? l.pathname + l.search : l.toString());
  }
  const title = pageTitleOf($);
  return {
    url: f.url, emails: extractFromDom($, f.html), ...(title ? { title } : {}), links, at: Date.now(),
    ...(f.etag ? { etag: f.etag } : {}), ...(f.lastModified ? { lastModified: f.lastModified } : {}),
  };
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
  reused = 0; // of `pages`, those taken from the category's earlier fetches
  attempts = 0;
  section: string | null = null;
  landingKey = '';

  /** `origin` is the landing page's; `robots` are its rules. */
  constructor(readonly host: string, readonly origin: string, readonly robots: RobotsRules, private readonly maxDepth: number) {}

  /** `again` re-queues a saved page, which is already in `seen`. */
  enqueue(u: URL, depth: number, again = false): void {
    if (this.maxDepth && depth > this.maxDepth) return;
    if (!crawlable(u, this.host)) return;
    const key = canonical(u);
    if (this.seen.has(key) && !again) return;
    // The site's other origins (www./bare host, http:, another port) are checked against their own robots.txt by allows().
    if (u.origin === this.origin && !allowed(this.robots, u.toString())) return;
    this.seen.add(key);
    this.queue.push(u.toString(), priority(u, depth, this.section));
    this.depthOf.set(u.toString(), depth);
  }

  /** Records the page's emails and returns its links. */
  ingest(rec: PageRecord): URL[] {
    const link = rec.url;
    const u = new URL(link);
    const title = this.section && inSection(u, this.section) && canonical(u) !== this.landingKey ? rec.title : undefined;
    for (const f of rec.emails) merge(this.emails, f.email, { name: f.name, link, pageTitle: title, source: f.source, nameFrom: f.nameFrom });
    const links: URL[] = [];
    for (const l of rec.links) {
      try { links.push(new URL(l, link)); } catch { /* ignore */ }
    }
    return links;
  }

  /** Whether robots.txt lets us fetch `url`, by the rules of its own origin (loaded once per origin for the run). */
  async allows(url: string): Promise<boolean> {
    return new URL(url).origin === this.origin ? allowed(this.robots, url) : robotsAllow(url);
  }
}

interface CrawlOut {
  emails: Map<string, EmailHit>;
  pages: number; // successful fetches
  reused: number; // of `pages`, those taken from the category's earlier fetches
  home: Fetched | null;
  blocked?: RobotsBlock; // landing page kept out by robots.txt
  state?: SiteCrawl; // set once the landing page loaded
  outOfTime?: boolean; // stopped by the deadline or the abort signal with pages still queued
  stop?: Stop; // why the queue run ended
}

/** Why a crawl's queue run ended: nothing left, time ran out, or the page cap was reached, with pages still queued. */
type Stop = 'done' | 'time' | 'cap';

interface RunLimits {
  deadline?: number;
  concurrency?: number;
  signal?: AbortSignal;
  pages?: { store: PageStore; mode: Mode; cutoff: number }; // the category's fetched pages for this phase: reused, revalidated, added to
}

const pagesOf = (opt: CrawlOptions, mode: Mode): RunLimits['pages'] => opt.pages && { store: opt.pages, mode, cutoff: opt.pagesCutoff ?? 0 };

/** Fetches queued pages until the queue is empty, time runs out or the attempt cap is hit. */
async function runQueue(c: SiteCrawl, fetcher: Fetcher, maxPages: number, opts: RunLimits): Promise<Stop> {
  const stopped = () => !!opts.signal?.aborted || (!!opts.deadline && Date.now() > opts.deadline);
  let inflight = 0;
  let outOfTime = false;
  let capped = false;
  const workers = Array.from({ length: opts.concurrency ?? 3 }, async () => {
    for (;;) {
      if (stopped()) { outOfTime = true; return; }
      if (maxPages > 0 && c.attempts >= maxPages) { capped = true; return; }
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
        if (!(await c.allows(item.url))) {
          c.attempts--;
          log.debug({ url: item.url }, "skipping a page that its host's robots.txt disallows");
          continue;
        }
        // Another site of the category may already have this page, or be fetching it right now (see PageStore.load).
        // A reused page still counts toward --max-pages, so a site is crawled exactly as it would be without the store.
        let skipped = false;
        const key = pageKey(new URL(item.url));
        const fetchRecord = async (stale?: PageRecord): Promise<PageRecord | null> => {
          const validators: Validators | undefined = stale && (stale.etag || stale.lastModified) ? { etag: stale.etag, lastModified: stale.lastModified } : undefined;
          const r = await fetcher(item.url, validators);
          if (!r) return null;
          if (r.gone) {
            opts.pages?.store.markGone(opts.pages.mode, key);
            return null;
          }
          if (r.notModified && stale) return { ...stale, at: Date.now() }; // revalidated: the stored copy is current
          if (r.url !== item.url) {
            // a redirect: don't fetch the target again, and don't take emails from another site or a disallowed page
            c.seen.add(canonical(new URL(r.url)));
            if (r.disallowed || !sameSite(new URL(r.url), c.host) || !(await c.allows(r.url))) {
              log.debug({ url: item.url, to: r.url }, 'skipping a redirect off the site or into a disallowed path');
              skipped = true;
              return null;
            }
          }
          return makeRecord(r);
        };
        const got = opts.pages
          ? await opts.pages.store.load(opts.pages.mode, key, opts.pages.cutoff, fetchRecord)
          : await fetchRecord().then((rec) => (rec ? { rec, reused: false } : null));
        if (got === 'gone') {
          log.debug({ url: item.url }, 'skipping a page that is gone (404/410)');
          continue;
        }
        if (!got) {
          // cut off by the hard stop: back into the queue, so it is saved for a later run
          if (opts.signal?.aborted && !skipped) {
            c.queue.push(item.url, item.pri);
            c.attempts--;
          }
          continue;
        }
        if (got.rec.url !== item.url) c.seen.add(canonical(new URL(got.rec.url)));
        if (got.reused) {
          c.reused++;
          log.debug({ url: item.url }, 'reusing a page this category already scraped');
        }
        c.pages++;
        const d = (c.depthOf.get(item.url) ?? 1) + 1;
        for (const l of c.ingest(got.rec)) c.enqueue(l, d);
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
    return 'time';
  }
  if (capped && c.queue.size) {
    log.debug({ pages: c.pages, queued: c.queue.size, maxPages }, `page cap of ${maxPages} reached with ${c.queue.size} pages still queued; continue with --retry-capped and a higher --max-pages`);
    return 'cap';
  }
  return 'done';
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
    return { emails: none, pages: 0, reused: 0, home: null, blocked: blockReason(robots) };
  }

  // homepage first (sequential so we know the final host)
  const first = await fetcher(start);
  if (!first || first.gone) {
    log.debug({ url: start }, 'start URL unreachable');
    return { emails: none, pages: 0, reused: 0, home: null };
  }
  const landing = new URL(first.url);
  // A redirect to another server means that server's robots.txt applies; a redirect may also land on a disallowed path.
  if (landing.origin !== new URL(start).origin) robots = await loadRobots(landing.origin);
  if (first.disallowed || !allowed(robots, first.url)) {
    log.info({ url: first.url, start }, `robots.txt disallows ${first.url} (redirected from ${start})`);
    return { emails: none, pages: first.disallowed ? 0 : 1, reused: 0, home: first, blocked: blockReason(robots) };
  }
  const c = new SiteCrawl(landing.hostname, landing.origin, robots, opts.maxDepth ?? 0);
  c.attempts = 1;
  c.pages = 1;
  c.section = sectionPrefix(new URL(start), landing);
  c.landingKey = canonical(landing);
  c.seen.add(c.landingKey);
  c.seen.add(canonical(new URL(start)));

  try {
    // The landing page is always requested (its business name and look are read from the HTML), but other sites can reuse its data.
    const rec = makeRecord(first);
    if (opts.pages && sameSite(landing, new URL(start).hostname)) {
      for (const u of new Set([start, first.url])) opts.pages.store.put(opts.pages.mode, pageKey(new URL(u)), rec, opts.pages.cutoff);
    }
    for (const l of c.ingest(rec)) c.enqueue(l, 1);
  } catch (err) {
    log.debug({ url: first.url, err }, 'page processing failed');
  }
  if (opts.useSitemap && !stopped()) {
    const load = () => loadSitemapUrls(landing.origin, sitemapsOf(robots), { deadline: opts.deadline, signal: opts.signal });
    const sm = opts.pages ? await opts.pages.store.sitemap(landing.origin, load, () => !stopped()) : await load();
    for (const s of sm) {
      try {
        const u = new URL(s);
        if (!c.section || inSection(u, c.section)) c.enqueue(u, 1);
      } catch { /* ignore */ }
    }
  }

  const stop = await runQueue(c, fetcher, maxPages, opts);
  return { emails: c.emails, pages: c.pages, reused: c.reused, home: first, state: c, outOfTime: stop === 'time', stop };
}

interface Leftover {
  queued: QueuedPage[];
  total: number; // queued pages before the MAX_SAVED_QUEUE cap
  capped: boolean; // `queued` was left by the page cap, not the time budget
  limited: QueuedPage[];
  seen?: string[];
}

type Carry = { queued: QueuedPage[]; limited: QueuedPage[]; capped?: boolean };

/**
 * What an HTTP crawl leaves for a later run: its queue if time ran out or the page cap was hit (drained best
 * first), the pages the server rate-limited, plus `carry` (saved parts a resume didn't work on), and
 * everything else it saw.
 */
function leftover(c: SiteCrawl, stop: Stop, limitedUrls: Iterable<string>, carry: Carry = { queued: [], limited: [] }): Leftover {
  const queued: QueuedPage[] = [];
  if (stop !== 'done') for (let it = c.queue.pop(); it; it = c.queue.pop()) queued.push([it.url, c.depthOf.get(it.url) ?? 1]);
  queued.push(...carry.queued);
  // A capped queue stays capped unless this pass ran out of time, which makes the whole queue a time-budget one.
  const capped = stop === 'cap' || (stop === 'done' && !!carry.capped && carry.queued.length > 0);
  const fresh = [...limitedUrls].filter((u) => c.depthOf.has(u)).map((u): QueuedPage => [u, c.depthOf.get(u)!]);
  const limited = [...new Map([...carry.limited, ...fresh].map((p) => [p[0], p])).values()];
  if (!queued.length && !limited.length) return { queued, total: 0, capped: false, limited };
  const pending = new Set<string>();
  for (const [u] of queued) {
    try { pending.add(canonical(new URL(u))); } catch { /* ignore */ }
  }
  return { queued: queued.slice(0, MAX_SAVED_QUEUE), total: queued.length, capped: capped && queued.length > 0, limited, seen: [...c.seen].filter((k) => !pending.has(k)) };
}

function resumeState(left: Leftover | undefined, attempts: number, browser?: ResumeState['browser']): ResumeState | undefined {
  if (!left?.queued.length && !left?.limited.length && !browser) return undefined;
  const s: ResumeState = { queued: left?.queued ?? [], limited: left?.limited ?? [], attempts };
  if (left?.capped) s.capped = true;
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
      out = await crawl(start, fetcher, opt.browserPages, { concurrency: 2, deadline, maxDepth: opt.maxDepth, signal, pages: pagesOf(opt, 'b') });
      if (out.blocked || out.home) break;
    }
    return out;
  } finally {
    await close();
  }
}

const toHit = (e: FoundOnPage): EmailHit => ({ name: e.name, link: e.link, pageTitle: e.pageTitle, source: e.source, nameFrom: e.nameFrom });
const toFound = ([email, h]: [string, EmailHit]): FoundOnPage => ({ email, name: h.name, link: h.link, pageTitle: h.pageTitle, source: h.source, nameFrom: h.nameFrom });

/** Gets the result as it stands before the browser phase, for the hard timeout to fall back on if that phase hangs. */
export type OnPartial = (r: SiteResult) => void;

/**
 * Crawls one site: plain HTTP first, then a headless browser when the site couldn't be loaded, looks
 * JS-rendered or gave no emails. Aborting `signal` (the hard timeout) stops it and returns what was found.
 * When time runs out or the server rate-limits pages, `resume` records what is left for resumeSite().
 */
export async function scrapeSite(site: string, options: Partial<CrawlOptions> = {}, signal?: AbortSignal, onPartial?: OnPartial): Promise<SiteResult> {
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
  let reused = 0;
  let homeHtml: string | null = null;
  let homeHost = new URL(site).hostname;

  // --- Phase 1: plain HTTP ---
  let httpOut: CrawlOut | null = null;
  let rateLimited = 0;
  const limited = new Set<string>();
  // Why each start URL's landing page didn't load (crawl() stops right after a failed landing page).
  const fails: string[] = [];
  let lastFail = '';
  const fetchHttp = httpFetcher(signal, (url) => { rateLimited++; limited.add(url); }, (kind) => { lastFail = kind; });
  for (const start of candidateStarts(site)) {
    if (signal?.aborted) break;
    lastFail = '';
    const out = await crawl(start, fetchHttp, opt.maxPages, { useSitemap: true, deadline, maxDepth: opt.maxDepth, concurrency: opt.pageConcurrency, signal, pages: pagesOf(opt, 'h') });
    if (!out.home && !out.blocked) fails.push(lastFail || 'network');
    if (out.blocked) {
      result.error = out.blocked;
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
    reused += httpOut.reused;
    for (const [e, h] of httpOut.emails) all.set(e, h);
  }
  const left = httpOut?.state ? leftover(httpOut.state, httpOut.stop ?? 'done', limited) : undefined;
  if (left?.total) {
    if (left.capped) result.capQueued = left.total;
    else result.budgetQueued = left.total;
  }
  if (!httpOut?.home && fails.length) result.errorDetail = fails[0];
  // No start URL resolves in DNS: the browser can't load it either.
  const noSuchHost = !httpOut?.home && fails.length > 0 && fails.every((f) => f === ('dns' satisfies FailKind));

  /** The result from what has been found so far; `owed` is a browser phase still to run. */
  const assemble = (owed: ResumeState['browser']): SiteResult => {
    const r: SiteResult = { ...result };
    if (rateLimited) r.rateLimited = rateLimited;
    if (reused) r.reused = reused;
    const resume = resumeState(left, httpOut?.state?.attempts ?? 0, owed);
    if (resume) r.resume = resume;
    if (signal?.aborted) r.error ??= 'timeout';
    if (!homeHtml) {
      r.error ??= 'unreachable';
      return r;
    }
    r.business = businessName(homeHtml, homeHost);
    r.emails = [...all].map(toFound);
    demoteRolePrefixes(r.emails);
    return r;
  };

  // --- Phase 2: headless browser fallback ---
  const jsRendered = !httpOut?.home || looksJsRendered(httpOut.home.html);
  const wantBrowser = opt.browserPages > 0 && !noSuchHost && (jsRendered || all.size === 0);
  const owedKind = jsRendered ? 'js-rendered' : 'no-emails';
  let browserOwed: ResumeState['browser'];
  if (wantBrowser && !signal?.aborted && Date.now() < deadline) {
    onPartial?.(assemble(httpOut?.home ? owedKind : undefined));
    try {
      // Start where Phase 1 landed when it got in; otherwise try every variant, http:// included.
      const out = await browserPhase(httpOut?.home ? [httpOut.home.url] : candidateStarts(site), opt, deadline, signal);
      if (out?.blocked) {
        result.error = out.blocked; // keep Phase 1's emails
        if (out.home && !httpOut?.home) result.finalUrl = out.home.url;
      } else if (out?.home) {
        result.usedBrowser = true;
        result.pages += out.pages;
        reused += out.reused;
        homeHtml ??= out.home.html;
        if (!httpOut?.home) {
          homeHost = new URL(out.home.url).hostname;
          result.finalUrl = out.home.url;
        }
        for (const [e, h] of out.emails) merge(all, e, h);
        if (out.outOfTime) {
          browserOwed = owedKind;
          result.budgetQueued = out.state?.queue.size;
        }
      }
    } catch (err) {
      result.error = 'browser-error';
      log.error({ err }, `headless browser failed on this site${httpOut?.home ? '; kept the plain-HTTP results' : ''}: ${firstLine(err)}`);
    }
  } else if (wantBrowser && httpOut?.home) {
    browserOwed = owedKind;
  }
  return assemble(browserOwed);
}

/** Which saved parts of a ResumeState to work on. */
export interface ResumeParts {
  budget: boolean; // the queue left when time ran out, and a browser phase still owed
  limited: boolean; // the pages the server rate-limited
  capped?: boolean; // the queue left when the page cap was hit (needs a higher --max-pages)
}

/**
 * Continues an earlier scrapeSite() from its saved `resume` state instead of starting over. Pages fetched
 * before are never fetched again, and new emails are merged into `prev`'s. Parts not selected are carried
 * over unchanged, so they can still be continued later. Returns `prev` when there is nothing to do or
 * robots.txt now disallows the landing page.
 */
export async function resumeSite(prev: SiteResult, parts: ResumeParts, options: Partial<CrawlOptions> = {}, signal?: AbortSignal, onPartial?: OnPartial): Promise<SiteResult> {
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

  const c = new SiteCrawl(landing.hostname, landing.origin, robots, opt.maxDepth);
  c.section = sectionPrefix(new URL(prev.site), landing);
  c.landingKey = canonical(landing);
  for (const k of saved.seen ?? []) c.seen.add(k);
  for (const [u] of saved.queued) {
    try { c.seen.add(canonical(new URL(u))); } catch { /* ignore */ }
  }
  let takeQueued = saved.queued.length > 0 && (saved.capped ? !!parts.capped : parts.budget);
  let takeLimited = parts.limited && saved.limited.length > 0;
  // A rate-limited page's failed attempt is given back when it is tried again.
  if (opt.maxPages > 0 && (takeQueued || takeLimited) && saved.attempts - (takeLimited ? saved.limited.length : 0) >= opt.maxPages) {
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
  let stop: Stop = 'done';
  if (c.queue.size) {
    const fetchHttp = httpFetcher(signal, (url) => { rateLimited++; limited.add(url); });
    stop = await runQueue(c, fetchHttp, opt.maxPages, { deadline, concurrency: opt.pageConcurrency, signal, pages: pagesOf(opt, 'h') });
  }
  const outOfTime = stop === 'time';
  const left = leftover(c, stop, limited, { queued: takeQueued ? [] : saved.queued, limited: takeLimited ? [] : saved.limited, capped: saved.capped });

  const all = new Map(prev.emails.map((e) => [e.email, toHit(e)] as const));
  for (const [e, h] of c.emails) merge(all, e, h);
  let pages = prev.pages + c.pages;
  let reused = (prev.reused ?? 0) + c.reused;
  let usedBrowser = prev.usedBrowser;
  let error = prev.error === 'timeout' ? undefined : prev.error;
  let browserQueued = 0;
  let owed = saved.browser === 'no-emails' && all.size ? undefined : saved.browser;

  const build = (): SiteResult => {
    const result: SiteResult = { v: CACHE_VERSION, site: prev.site, finalUrl: prev.finalUrl, business: prev.business, emails: [...all].map(toFound), pages, usedBrowser };
    const limitedTotal = (takeLimited ? 0 : prev.rateLimited ?? 0) + rateLimited;
    if (limitedTotal) result.rateLimited = limitedTotal;
    if (reused) result.reused = reused;
    // Informational counts: pages still queued, whether carried over or left by this pass.
    const carried = takeQueued ? 0 : saved.queued.length ? (saved.capped ? prev.capQueued : prev.budgetQueued) ?? saved.queued.length : 0;
    const queued = left.total - (takeQueued ? 0 : saved.queued.length) + carried;
    if (left.capped) {
      if (queued > 0) result.capQueued = queued;
      if (browserQueued > 0) result.budgetQueued = browserQueued;
    } else if (queued + browserQueued > 0) {
      result.budgetQueued = queued + browserQueued;
    }
    const resume = resumeState(left, c.attempts, owed);
    if (resume) result.resume = resume;
    const err = error ?? (signal?.aborted ? 'timeout' : undefined);
    if (err) result.error = err;
    demoteRolePrefixes(result.emails);
    return result;
  };

  if (parts.budget && owed && opt.browserPages > 0 && !outOfTime && !signal?.aborted && Date.now() < deadline) {
    onPartial?.(build());
    try {
      const out = await browserPhase([prev.finalUrl], opt, deadline, signal);
      owed = undefined;
      if (error === 'browser-error') error = undefined;
      if (out?.blocked) {
        error = out.blocked;
      } else if (out?.home) {
        usedBrowser = true;
        pages += out.pages;
        reused += out.reused;
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
  return build();
}

/**
 * A re-crawl added to the row it replaces (owner decision): the old row's emails stay exactly as they were, and
 * only addresses the re-crawl found that the old row doesn't have are added. The crawl state (resume, counters)
 * comes from the re-crawl, so a mark on the old row doesn't send it back into every later retry.
 */
export function mergeResults(prev: SiteResult, next: SiteResult): SiteResult {
  const known = new Set(prev.emails.map((e) => e.email));
  const added = next.emails.filter((e) => !known.has(e.email));
  const reached = next.pages > 0;
  const out: SiteResult = {
    ...prev,
    v: next.v,
    emails: [...prev.emails, ...added],
    pages: reached ? next.pages : prev.pages,
    reused: reached ? next.reused : prev.reused,
    usedBrowser: prev.usedBrowser || next.usedBrowser,
    error: reached ? next.error : prev.error,
    rateLimited: next.rateLimited,
    budgetQueued: next.budgetQueued,
    capQueued: next.capQueued,
    resume: next.resume,
  };
  for (const k of ['v', 'error', 'reused', 'rateLimited', 'budgetQueued', 'capQueued', 'resume'] as const) if (out[k] === undefined) delete out[k];
  demoteRolePrefixes(out.emails);
  return out;
}
