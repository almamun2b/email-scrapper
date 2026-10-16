import { setTimeout as sleep } from 'node:timers/promises';
import pLimit from 'p-limit';
import { Agent, fetch } from 'undici';
import { untilAborted } from './abort.js';
import { log } from './logger.js';
import { guardedLookup, isPublicHost } from './netguard.js';
import { baseHost } from './urls.js';

export const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HTTP_TIMEOUT = 15_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const RETRY_AFTER_MS = 3_000; // wait before the one retry, unless the server's Retry-After says otherwise
const MAX_RETRY_AFTER_MS = 30_000;
// Network errors that won't go away 3 seconds later: no such host, nothing listening, broken TLS, a private address.
const PERMANENT_NET_ERROR = /^(ENOTFOUND|EAI_NONAME|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EBLOCKED)$|CERT|TLS|SSL/i;

// Connections resolve through the address guard, so they go to the addresses it checked (no DNS rebinding).
const dispatcher = new Agent({ connect: { lookup: guardedLookup } });

export interface HttpResult {
  status: number;
  url: string; // final URL after redirects
  type: string; // content-type header
  body: string; // decoded text; empty for error statuses and skipped content types
  bytes: Buffer; // raw body (gzip sitemaps are binary)
  disallowed?: boolean; // a redirect led to `url`, which allowHop refused: not requested (status 0)
  etag?: string; // validators of the answer, for revalidating the page later with a conditional request
  lastModified?: string;
}

export interface GetOptions {
  accept?: string;
  headers?: Record<string, string>; // extra request headers, e.g. If-None-Match to revalidate a stored page (a 304 comes back with an empty body)
  types?: RegExp; // content types worth reading; anything else is not downloaded
  signal?: AbortSignal;
  onRateLimited?: (url: string, status: number) => void; // still 429/503 after the retry; the page is skipped
  allowHop?: (url: string) => Promise<boolean>; // asked before following each redirect (robots.txt of the target)
  onFail?: (kind: FailKind) => void; // why a request got no answer (the last reason wins when it was retried)
}

/** Why a request got no answer: no such host, nothing listening, broken TLS, a private address, … */
export type FailKind = 'dns' | 'refused' | 'tls' | 'timeout' | 'reset' | 'private' | 'redirects' | 'network';

export function failKind(code: string): FailKind {
  if (/^(ENOTFOUND|EAI_NONAME|EAI_AGAIN|EAI_FAIL|EAI_NODATA)$/.test(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'EBLOCKED') return 'private';
  if (/CERT|TLS|SSL/i.test(code)) return 'tls';
  if (/TIMEOUT|ETIMEDOUT/i.test(code)) return 'timeout';
  if (/ECONNRESET|EPIPE|SOCKET/i.test(code)) return 'reset';
  return 'network';
}

// ---------------- per-server limits ----------------

// Caps concurrent requests to one server across all sites crawled in parallel
// (many input domains can redirect to the same host).
let hostConcurrency = 3;
const hostLimits = new Map<string, ReturnType<typeof pLimit>>();
const crawlDelay = new Map<string, number>(); // ms between requests, from robots.txt
const backoff = new Map<string, number>(); // extra ms between requests while a server answers 429/503
const nextSlot = new Map<string, number>();
const MIN_BACKOFF_MS = 1_000;
const MAX_GAP_MS = 10_000;

/** Set before the first request: limiters already created keep their size. */
export function setHostConcurrency(n: number): void {
  hostConcurrency = Math.max(1, Math.floor(n));
}

/** Honours a robots.txt Crawl-delay for a server, capped so one site can't stall the run. */
export function setCrawlDelay(hostname: string, seconds: number): void {
  if (seconds > 0) crawlDelay.set(baseHost(hostname), Math.min(seconds * 1000, MAX_GAP_MS));
}

/**
 * Adapts to a server's rate limiting, shared by every site on it: each 429/503 doubles the gap
 * between its requests (1 s up to 10 s), each normal answer halves it again.
 */
function pace(host: string, limited: boolean): void {
  const cur = backoff.get(host) ?? 0;
  if (limited) backoff.set(host, Math.min(MAX_GAP_MS, Math.max(MIN_BACKOFF_MS, cur * 2)));
  else if (cur / 2 >= MIN_BACKOFF_MS) backoff.set(host, cur / 2);
  else backoff.delete(host);
}

/** Current ms between requests to a server: the larger of its Crawl-delay and its rate-limit backoff. */
export function hostGapMs(hostname: string): number {
  const host = baseHost(hostname);
  return Math.max(crawlDelay.get(host) ?? 0, backoff.get(host) ?? 0);
}

/** Forgets all per-server pacing (tests only: every local test server is 127.0.0.1). */
export function resetHostPacing(): void {
  crawlDelay.clear();
  backoff.clear();
  nextSlot.clear();
}

function hostLimit(host: string): ReturnType<typeof pLimit> {
  let l = hostLimits.get(host);
  if (!l) hostLimits.set(host, (l = pLimit(hostConcurrency)));
  return l;
}

/** Inside a host slot: waits until this server's gap (Crawl-delay or backoff) since the previous request has passed. */
async function waitTurn(host: string, signal?: AbortSignal): Promise<void> {
  const gap = hostGapMs(host);
  if (!gap || signal?.aborted) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + gap);
  if (at > now) await sleep(at - now, undefined, { signal }).catch(() => {});
}

/**
 * Runs `fn` in one of the server's slots, after its gap (Crawl-delay or rate-limit backoff). The HTTP client and
 * the headless browser both use it, so one server sees the same limits from either. Gives null as soon as
 * `signal` aborts, even while still queued for a slot that other sites' requests hold.
 */
export function withHostSlot<T>(hostname: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T | null> {
  const host = baseHost(hostname);
  const run = hostLimit(host)(async () => {
    if (signal?.aborted) return null;
    await waitTurn(host, signal);
    if (signal?.aborted) return null;
    return fn();
  });
  return untilAborted(run, signal, null);
}

/** Feeds a server's answer into its rate-limit backoff (see pace). */
export function notePace(hostname: string, status: number): void {
  pace(baseHost(hostname), status === 429 || status === 503);
}

// ---------------- requests ----------------

/** Worth one more try: rate limiting (429/503) or a transient network error. */
class Retry {
  constructor(readonly result: HttpResult | null, readonly waitMs = RETRY_AFTER_MS) {}
}

/** Retry-After as a wait in ms (seconds or an HTTP date), kept within 1–30 s; the default when absent. */
export function retryAfterMs(header: string | null): number {
  if (!header) return RETRY_AFTER_MS;
  const secs = /^\s*\d+\s*$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(secs)) return RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, secs));
}

const STATUS_TEXT: Record<number, string> = { 429: 'Too Many Requests', 503: 'Service Unavailable' };
const warnedRateLimited = new Set<string>();

/** Explains a page given up to rate limiting: once per server at warn, then at debug (the site's summary counts them). */
function reportRateLimited(url: string, status: number): void {
  const u = new URL(url);
  const host = baseHost(u.hostname);
  const first = !warnedRateLimited.has(host);
  warnedRateLimited.add(host);
  const what = `HTTP ${status} ${STATUS_TEXT[status] ?? ''}`.trim();
  const msg = first
    ? `${host} is rate-limiting requests (${what}); skipped ${u.pathname} after one retry. Further refused pages are counted in the site's summary`
    : `${host} is rate-limiting requests (${what}); skipped ${u.pathname} after one retry`;
  log[first ? 'warn' : 'debug']({ url, status, host }, msg);
}

/**
 * GET with redirects followed by hand (each hop must be a public host), a per-server concurrency
 * limit, one retry for rate limiting or transient network errors, and a 5 MB cap. Returns null on
 * network failure, a blocked host or an abort; error statuses come back with an empty body.
 */
export async function httpGet(url: string, opts: GetOptions = {}): Promise<HttpResult | null> {
  const first = await once(url, opts);
  if (!(first instanceof Retry)) return first;
  if (opts.signal?.aborted) return first.result;
  await sleep(first.waitMs, undefined, { signal: opts.signal }).catch(() => {});
  if (opts.signal?.aborted) return first.result;
  const second = await once(url, opts);
  if (!(second instanceof Retry)) return second;
  if (second.result) {
    reportRateLimited(second.result.url, second.result.status);
    opts.onRateLimited?.(second.result.url, second.result.status);
  }
  return second.result;
}

async function once(url: string, opts: GetOptions): Promise<HttpResult | null | Retry> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (hop > 0 && opts.allowHop && !(await opts.allowHop(current))) {
      return { status: 0, url: current, type: '', body: '', bytes: Buffer.alloc(0), disallowed: true };
    }
    if (!(await isPublicHost(u.hostname))) {
      log.debug({ url: current, from: url }, 'refusing a request to a private or local address');
      opts.onFail?.('private');
      return null;
    }
    const r = await withHostSlot(u.hostname, opts.signal, () => request(current, opts));
    if (typeof r !== 'object' || r === null || !('redirect' in r)) return r;
    current = r.redirect;
  }
  log.debug({ url }, 'too many redirects');
  opts.onFail?.('redirects');
  return null;
}

async function request(url: string, opts: GetOptions): Promise<HttpResult | null | Retry | { redirect: string }> {
  if (opts.signal?.aborted) return null;
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    const res = await fetch(url, {
      dispatcher,
      signal,
      redirect: 'manual',
      headers: {
        'user-agent': UA,
        accept: opts.accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en-AU,en-NZ;q=0.9,en;q=0.8',
        ...opts.headers,
      },
    });
    notePace(new URL(url).hostname, res.status);
    const type = res.headers.get('content-type') ?? '';
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    const result = (body = '', bytes = Buffer.alloc(0)): HttpResult => ({ status: res.status, url, type, body, bytes, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) });
    // Always release an unread body: cheerio loads npm undici, which then backs global fetch, and
    // an abandoned body on a connection the server closes crashes the process (undici Parser.finish assertion).
    const release = async () => { await res.body?.cancel().catch(() => {}); };
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await release();
      try {
        return { redirect: new URL(res.headers.get('location')!, url).toString() };
      } catch {
        return null;
      }
    }
    if (!res.ok) {
      await release();
      log.debug({ url, status: res.status }, `HTTP ${res.status}`);
      return res.status === 429 || res.status === 503 ? new Retry(result(), retryAfterMs(res.headers.get('retry-after'))) : result();
    }
    if (opts.types && type && !opts.types.test(type)) {
      await release();
      return result();
    }
    if (!res.body) return result();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total > MAX_BYTES) {
        log.debug({ url, bytes: total }, 'response too large, truncated');
        await reader.cancel().catch(() => {});
        break;
      }
    }
    const bytes = Buffer.concat(chunks);
    return result(decode(bytes, type), bytes);
  } catch (err) {
    if (opts.signal?.aborted) return null;
    if (timeout.aborted) {
      log.debug({ url, timeoutMs: HTTP_TIMEOUT }, 'request timed out');
      opts.onFail?.('timeout');
      return null;
    }
    const code = String((err as { cause?: { code?: string } })?.cause?.code ?? '');
    log.debug({ url, err, code }, 'network error');
    opts.onFail?.(failKind(code));
    return PERMANENT_NET_ERROR.test(code) ? null : new Retry(null);
  }
}

/** Decodes with the charset from the header, else a <meta> charset in the first 2 KB, else UTF-8. */
export function decode(bytes: Buffer, contentType: string): string {
  const head = bytes.subarray(0, 2048).toString('latin1');
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
