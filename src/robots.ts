import { setTimeout as sleep } from 'node:timers/promises';
import robotsModule from 'robots-parser';
import { httpGet, setCrawlDelay, UA } from './http.js';
import { log } from './logger.js';

interface Robots {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getSitemaps(): string[];
  getCrawlDelay(ua?: string): number | undefined;
}
const robotsParser = ((robotsModule as any).default ?? robotsModule) as (url: string, txt: string) => Robots;

/**
 * Parsed rules; ROBOTS_UNAVAILABLE when the server errors, which means "keep out" (RFC 9309) but may be temporary;
 * undefined when there is no robots.txt.
 */
export type RobotsRules = Robots | typeof ROBOTS_UNAVAILABLE | undefined;
export const ROBOTS_UNAVAILABLE = 'robots-unavailable' as const;

/** The SiteResult error for a landing page robots.txt keeps us out of. */
export type RobotsBlock = 'robots-disallowed' | 'robots-unavailable';
export const blockReason = (robots: RobotsRules): RobotsBlock => (robots === ROBOTS_UNAVAILABLE ? 'robots-unavailable' : 'robots-disallowed');

const cache = new Map<string, Promise<RobotsRules>>();

/** robots.txt for an origin, cached for the whole run. Also registers its Crawl-delay with the HTTP layer. */
export function loadRobots(origin: string): Promise<RobotsRules> {
  let p = cache.get(origin);
  if (!p) {
    p = fetchRobots(origin);
    cache.set(origin, p);
  }
  return p;
}

async function fetchRobots(origin: string): Promise<RobotsRules> {
  const url = origin + '/robots.txt';
  let r = await httpGet(url, { accept: 'text/plain,*/*' });
  if (r && r.status >= 500) {
    await sleep(3_000);
    r = await httpGet(url, { accept: 'text/plain,*/*' });
  }
  // Unreachable (network error): treated as no robots.txt, as before. A server error means "keep out".
  if (!r) return undefined;
  if (r.status >= 500) {
    log.info({ url, status: r.status }, `robots.txt answers HTTP ${r.status}; treating the site as disallowed`);
    return ROBOTS_UNAVAILABLE;
  }
  if (r.status >= 400 || !/user-agent/i.test(r.body) || /<html/i.test(r.body)) return undefined;
  const robots = robotsParser(url, r.body);
  const delay = robots.getCrawlDelay(UA);
  if (delay) setCrawlDelay(new URL(origin).hostname, delay);
  return robots;
}

/**
 * `robots` must be the rules of `url`'s own origin: robots-parser answers undefined for any other origin, and
 * that reads as allowed here. SiteCrawl.allows() picks the right rules for each URL.
 */
export function allowed(robots: RobotsRules, url: string): boolean {
  if (robots === ROBOTS_UNAVAILABLE) return false;
  return robots?.isAllowed(url, UA) !== false;
}

/** Whether robots.txt lets us fetch `url`, by the rules of the URL's own origin. */
export async function robotsAllow(url: string): Promise<boolean> {
  return allowed(await loadRobots(new URL(url).origin), url);
}

export function sitemapsOf(robots: RobotsRules): string[] {
  return robots && robots !== ROBOTS_UNAVAILABLE ? robots.getSitemaps() : [];
}
