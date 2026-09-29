const SKIP_EXT =
  /\.(pdf|docx?|xlsx?|pptx?|zip|rar|gz|7z|jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|mp3|mp4|m4a|wav|avi|mov|wmv|webm|css|js|json|xml|rss|woff2?|ttf|eot|otf|exe|dmg|apk|csv|txt|ics)$/i;

const SKIP_PATH =
  /(\/wp-content\/uploads\/|\/wp-json\/|\/wp-admin|\/wp-login|\/xmlrpc|\/cart\b|\/checkout|\/login|\/logout|\/signin|\/register|\/my-account|\/feed\/?$|\/tag\/|\/author\/|\/calendar|\/cdn-cgi\/)/i;

const PRIORITY_PATH =
  /(contact|about|team|staff|people|our-|meet|doctor|dentist|vet\b|vets|veterinar|nurse|clinician|practitioner|location|clinic|practice|find-us|directory|enquir|reach|get-in-touch|connect|branch|hospital|service)/i;

export function normalizeInput(raw: string): string | null {
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function baseHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

export function sameSite(url: URL, host: string): boolean {
  return baseHost(url.hostname) === baseHost(host);
}

/** Canonical form used for de-duplication of pages. */
export function canonical(url: URL): string {
  const u = new URL(url.toString());
  u.hash = '';
  u.hostname = baseHost(u.hostname);
  let p = u.pathname.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  u.pathname = p;
  // drop tracking params, keep the rest (some sites use ?page=…)
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(k)) u.searchParams.delete(k);
  }
  u.searchParams.sort();
  return u.toString();
}

/** Whether a link is worth fetching as an HTML page. */
export function crawlable(url: URL, host: string): boolean {
  if (!/^https?:$/.test(url.protocol)) return false;
  if (!sameSite(url, host)) return false;
  if (SKIP_EXT.test(url.pathname)) return false;
  if (SKIP_PATH.test(url.pathname)) return false;
  // avoid crawl traps: many query params / very long URLs / deep paths
  if ([...url.searchParams.keys()].length > 2) return false;
  if (url.toString().length > 250) return false;
  if (url.pathname.split('/').length > 8) return false;
  return true;
}

/** True if `url` is inside the section rooted at `prefix` (e.g. /hospitals/auckland/central). */
export function inSection(url: URL, prefix: string): boolean {
  const p = url.pathname.replace(/\/+$/, '');
  return p === prefix || p.startsWith(prefix + '/');
}

/**
 * The path prefix to focus a crawl on, or null for a whole-site crawl.
 * A section is a landing page with a real path: one given in the input, one reached by a
 * redirect to another domain, or any path at least two segments deep. A single-segment
 * same-domain redirect like /home or /en is treated as the whole site.
 */
export function sectionPrefix(input: URL, landing: URL): string | null {
  const path = landing.pathname.replace(/\/+$/, '');
  if (!path || /^\/(index|default|home)(\.[a-z]+)?$/i.test(path)) return null;
  const inputHasPath = input.pathname.replace(/\/+$/, '') !== '';
  const crossDomain = baseHost(input.hostname) !== baseHost(landing.hostname);
  const deep = path.split('/').filter(Boolean).length >= 2;
  return inputHasPath || crossDomain || deep ? path : null;
}

/** Lower = fetched sooner. */
export function priority(url: URL, depth: number, section?: string | null): number {
  const p = decodeURIComponent(url.pathname);
  const hit = PRIORITY_PATH.test(p);
  const strong = /(contact|get-in-touch|enquir|find-us|about|team|staff|meet)/i.test(p);
  const sectionAdj = section ? (inSection(url, section) ? -20 : 15) : 0;
  return (strong ? 0 : hit ? 5 : 20) + depth * 3 + (url.search ? 4 : 0) + sectionAdj;
}
