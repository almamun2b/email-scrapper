import pLimit from 'p-limit';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { UA } from './http.js';
import { log } from './logger.js';
import { isPublicHost } from './netguard.js';

export interface Fetched {
  html: string;
  url: string; // final URL after redirects
}
export type Fetcher = (url: string) => Promise<Fetched | null>;

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

export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (p) {
    const b = await p.catch(() => null);
    await b?.close().catch(() => {});
  }
}

const newContext = (b: Browser) => b.newContext({ userAgent: UA, locale: 'en-AU', ignoreHTTPSErrors: true, acceptDownloads: false });

/** A browser context for one site, with a page fetcher that matches the HTTP fetcher's contract. */
export function makeBrowserFetcher(signal?: AbortSignal): { fetcher: Fetcher; close: () => Promise<void> } {
  let ctxPromise: Promise<BrowserContext> | null = null;
  const ctx = () => {
    if (!ctxPromise) {
      const p = getBrowser()
        .then(newContext)
        .catch(async (err) => {
          // the shared browser died between launch and now: start a fresh one once
          if (!/closed|disconnected|Target/i.test(String(err))) throw err;
          browserPromise = null;
          return newContext(await getBrowser());
        });
      ctxPromise = p;
      p.catch(() => { if (ctxPromise === p) ctxPromise = null; });
    }
    return ctxPromise;
  };
  const fetcher: Fetcher = (url) =>
    browserLimit(async () => {
      if (signal?.aborted) return null;
      const c = await ctx();
      const page = await c.newPage();
      try {
        await page.route('**/*', async (route) => {
          const req = route.request();
          const t = req.resourceType();
          if (t === 'image' || t === 'media' || t === 'font') return route.abort();
          const u = new URL(req.url());
          if (/^https?:$/.test(u.protocol) && !(await isPublicHost(u.hostname))) return route.abort('blockedbyclient');
          return route.continue();
        });
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        if (!resp || resp.status() >= 400) return null;
        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
        return { html: await page.content(), url: page.url() };
      } catch (err) {
        log.debug({ url, err: firstLine(err) }, 'browser page failed');
        return null;
      } finally {
        await page.close().catch(() => {});
      }
    });
  const close = async () => {
    const c = await ctxPromise?.catch(() => null);
    await c?.close().catch(() => {});
  };
  return { fetcher, close };
}
