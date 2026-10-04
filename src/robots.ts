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

/** Parsed rules; DISALLOW_ALL when the server errors (RFC 9309); undefined when there is no robots.txt. */
export type RobotsRules = Robots | typeof DISALLOW_ALL | undefined;
export const DISALLOW_ALL = 'disallow-all' as const;

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
    return DISALLOW_ALL;
  }
  if (r.status >= 400 || !/user-agent/i.test(r.body) || /<html/i.test(r.body)) return undefined;
  const robots = robotsParser(url, r.body);
  const delay = robots.getCrawlDelay(UA);
  if (delay) setCrawlDelay(new URL(origin).hostname, delay);
  return robots;
}

export function allowed(robots: RobotsRules, url: string): boolean {
  if (robots === DISALLOW_ALL) return false;
  return robots?.isAllowed(url, UA) !== false;
}

export function sitemapsOf(robots: RobotsRules): string[] {
  return robots && robots !== DISALLOW_ALL ? robots.getSitemaps() : [];
}
