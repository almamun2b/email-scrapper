import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import pLimit from 'p-limit';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { untilAborted } from './abort.js';
import { notePace, UA, withHostSlot } from './http.js';
import { log } from './logger.js';
import { isPublicHost } from './netguard.js';
import { baseHost } from './urls.js';

export interface Fetched {
  html: string;
  url: string; // final URL after redirects
  disallowed?: boolean; // a redirect led to `url`, which robots.txt disallows, so it wasn't fetched (html is empty)
  gone?: boolean; // the server answered 404/410: the page doesn't exist (html is empty)
  notModified?: boolean; // 304 to a conditional request: the stored copy is still current (html is empty)
  etag?: string; // validators of the answer (plain HTTP only), kept to revalidate the page later
  lastModified?: string;
}
/** Validators of a stored copy; a fetcher that supports them asks the server whether the page changed. */
export interface Validators { etag?: string; lastModified?: string }
export type Fetcher = (url: string, validators?: Validators) => Promise<Fetched | null>;

/** First line only: Playwright errors (e.g. browser not installed) are multi-line banners. */
export function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split('\n')[0].trim();
}

let browserPromise: Promise<Browser> | null = null;
const browserLimit = pLimit(4);

/**
 * One shared Chromium, sandboxed: it runs JavaScript from thousands of unknown sites. If it crashes or
 * fails to start, the next request launches a new one instead of failing for the rest of the run.
 */
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const sandbox = process.env.SCRAPER_NO_SANDBOX !== '1';
    const p = chromium.launch({ headless: true, chromiumSandbox: sandbox });
    browserPromise = p;
    p.then(
      (b) => b.on('disconnected', () => {
        if (browserPromise === p) browserPromise = null;
        log.warn('headless browser disconnected; a new one starts on the next request');
      }),
      (err) => {
        if (browserPromise === p) browserPromise = null;
        if (sandbox && /sandbox|namespace/i.test(String(err))) {
          log.error('Chromium could not start its sandbox. See README "Headless browser sandbox" (or set SCRAPER_NO_SANDBOX=1)');
        }
      },
    );
  }
  return browserPromise;
}

/** Runs `playwright install chromium` with the installed Playwright's own CLI, output shown on the terminal. */
function installChromium(): Promise<void> {
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`playwright install chromium exited with code ${code}`))));
  });
}

/**
 * Starts and closes Chromium once before a run. If Playwright's Chromium is missing (or is not the build the
 * installed Playwright expects), it is installed first, so the browser phase never fails a whole run.
 * Other launch failures (e.g. the sandbox) are left to getBrowser(), which reports them with its own hint.
 */
export async function ensureBrowser(): Promise<void> {
  const sandbox = process.env.SCRAPER_NO_SANDBOX !== '1';
  const tryLaunch = async () => (await chromium.launch({ headless: true, chromiumSandbox: sandbox })).close();
  try {
    await tryLaunch();
  } catch (err) {
    if (!/Executable doesn't exist|playwright install/i.test(String(err))) {
      log.warn({ err }, `Headless browser check failed: ${firstLine(err)}`);
      return;
    }
    log.warn("Playwright's Chromium is not installed; installing it (npx playwright install chromium)");
    await installChromium();
    await tryLaunch();
    log.info('Playwright Chromium installed');
  }
}

export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (p) {
    const b = await p.catch(() => null);
    await b?.close().catch(() => {});
  }
}

/** Skips images, media and fonts, and keeps every request (popups' too) off private and local addresses. */
async function guardRequest(route: Route): Promise<void> {
  const req = route.request();
  const t = req.resourceType();
  if (t === 'image' || t === 'media' || t === 'font') return route.abort();
  const u = new URL(req.url());
  if (/^https?:$/.test(u.protocol) && !(await isPublicHost(u.hostname))) return route.abort('blockedbyclient');
  return route.continue();
}

/**
 * The guards live on the context, not the page, so they also cover popups. Service workers are blocked because
 * their requests bypass routing, and WebSockets get the same address check as everything else.
 */
async function newContext(b: Browser): Promise<BrowserContext> {
  const c = await b.newContext({ userAgent: UA, locale: 'en-AU', ignoreHTTPSErrors: true, acceptDownloads: false, serviceWorkers: 'block' });
  await c.route('**/*', guardRequest);
  await c.routeWebSocket(() => true, async (ws) => {
    if (await isPublicHost(new URL(ws.url()).hostname)) ws.connectToServer();
    else await ws.close();
  });
  return c;
}

const CLOSED = /closed|disconnected|Target/i;

/** A browser context for one site, with a page fetcher that matches the HTTP fetcher's contract. */
export function makeBrowserFetcher(signal?: AbortSignal): { fetcher: Fetcher; close: () => Promise<void> } {
  let ctxPromise: Promise<BrowserContext> | null = null;
  const ctx = () => {
    if (!ctxPromise) {
      const p = getBrowser()
        .then(newContext)
        .catch(async (err) => {
          // the shared browser died between launch and now: start a fresh one once
          if (!CLOSED.test(String(err))) throw err;
          browserPromise = null;
          return newContext(await getBrowser());
        });
      ctxPromise = p;
      p.catch(() => { if (ctxPromise === p) ctxPromise = null; });
    }
    return ctxPromise;
  };
  // A context that died with the browser after it was created is replaced once, instead of failing every page.
  const newPage = async () => {
    try {
      return await (await ctx()).newPage();
    } catch (err) {
      if (!CLOSED.test(String(err))) throw err;
      ctxPromise = null;
      return (await ctx()).newPage();
    }
  };
  const fetcher: Fetcher = (url) =>
    untilAborted(browserLimit(async () => {
      if (signal?.aborted) return null;
      const page = await newPage();
      const stop = () => { page.close().catch(() => {}); }; // cuts a navigation short at the hard time limit
      signal?.addEventListener('abort', stop, { once: true });
      page.on('popup', (p) => { p.close().catch(() => {}); });
      try {
        // The same per-server slot, Crawl-delay and rate-limit backoff as the plain-HTTP requests.
        const resp = await withHostSlot(new URL(url).hostname, signal, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 }));
        if (resp) notePace(new URL(resp.url()).hostname, resp.status());
        if (!resp || resp.status() >= 400) return null;
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
        // Same-site frames' documents are added after the page's own, so their emails and links count too.
        const site = baseHost(new URL(page.url()).hostname);
        const frames = page.frames().filter((f) => {
          if (f === page.mainFrame()) return false;
          try { return baseHost(new URL(f.url()).hostname) === site; } catch { return false; }
        }).slice(0, 10);
        const extra = await Promise.all(frames.map((f) => f.content().catch(() => '')));
        return { html: [await page.content(), ...extra].join('\n'), url: page.url() };
      } catch (err) {
        log.debug({ url, err: firstLine(err) }, 'browser page failed');
        return null;
      } finally {
        signal?.removeEventListener('abort', stop);
        await page.close().catch(() => {});
      }
    }), signal, null);
  const close = async () => {
    const c = await ctxPromise?.catch(() => null);
    await c?.close().catch(() => {});
  };
  return { fetcher, close };
}
