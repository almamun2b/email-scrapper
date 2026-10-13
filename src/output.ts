import { getDomain } from 'tldts';
import type { FoundOnPage, SiteResult } from './crawler.js';
import { demoteRolePrefixes, recheckRow, tidyBusinessName } from './extract.js';

export type Row = [name: string, email: string, website: string, link: string];

/**
 * Neutralises spreadsheet formulas. Names come from third-party page titles, so a site titled
 * "=HYPERLINK(...)" would otherwise become a live formula when the CSV is opened in Excel or Sheets.
 */
export function safeCell(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * A stored result with the current email and name rules re-applied (see recheckRow). Fresh results pass
 * through unchanged; cached ones from older code get cleaned. The cache itself is never rewritten.
 */
export function recheckSite(r: SiteResult): SiteResult {
  const byEmail = new Map<string, FoundOnPage>();
  for (const e of r.emails) {
    const c = recheckRow(e);
    if (!c) continue;
    const prev = byEmail.get(c.email); // a ROT13 decode can land on an address already found
    if (!prev || (!prev.name && c.name)) byEmail.set(c.email, c);
  }
  const emails = [...byEmail.values()];
  demoteRolePrefixes(emails);
  let business = r.business;
  try {
    business = tidyBusinessName(r.business) ?? new URL(r.finalUrl).hostname.replace(/^www\./, '');
  } catch { /* keep */ }
  return { ...r, business, emails };
}

/** An email on this many sites, none of which owns its domain, is boilerplate (a regulator, a head office). */
export const SHARED_MIN_SITES = 3;

/** Registrable domain ("mail.acme.co.nz" → "acme.co.nz"), else the host itself. */
const regDomain = (host: string) => getDomain(host, { allowPrivateDomains: false }) ?? host.toLowerCase();
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

/** Which fallback gave a row its name, for the summary. */
export type NameKind = 'person' | 'department' | 'input' | 'business';

export interface Assigned {
  rows: Row[]; // the per-file CSV: unique by email, ordered by the credited site's place in the input
  shared: Row[]; // emails on SHARED_MIN_SITES+ sites that don't own them, for shared/<name>.csv
  sharedOn: Map<string, number>; // shared email → number of sites it was found on
  kinds: Record<NameKind, number>; // name source of each row in `rows`
}

/**
 * The output rows for one input file. Each email appears once and is credited to the site that owns it: the
 * first site whose registrable domain is the email's, else the first site where it wasn't only in raw HTML
 * (scripts, data blobs), else the first site. An email found on SHARED_MIN_SITES or more sites, none of which
 * owns its domain, goes to `shared` instead. The name is the person, else the department page title, else the
 * input's own name for the site, else the scraped business name.
 */
export function assignRows(sites: string[], done: Map<string, SiteResult>, inputNames: Map<string, string> = new Map()): Assigned {
  type Seen = { si: number; ei: number; site: string; r: SiteResult; e: FoundOnPage };
  const byEmail = new Map<string, Seen[]>();
  const domains = new Map<string, Set<string>>();
  sites.forEach((site, si) => {
    const r = done.get(site);
    if (!r) return;
    domains.set(site, new Set([regDomain(hostOf(site)), regDomain(hostOf(r.finalUrl))]));
    r.emails.forEach((e, ei) => {
      const list = byEmail.get(e.email) ?? [];
      list.push({ si, ei, site, r, e });
      byEmail.set(e.email, list);
    });
  });

  const main: (Seen & { row: Row })[] = [];
  const shared: Row[] = [];
  const sharedOn = new Map<string, number>();
  const kinds: Record<NameKind, number> = { person: 0, department: 0, input: 0, business: 0 };
  for (const [email, seen] of byEmail) {
    const own = regDomain(email.slice(email.indexOf('@') + 1));
    const owner = seen.find((x) => domains.get(x.site)!.has(own));
    const pick = owner ?? seen.find((x) => x.e.source !== 'raw') ?? seen[0];
    const inputName = inputNames.get(pick.site);
    const kind: NameKind = pick.e.name ? 'person' : pick.e.pageTitle ? 'department' : inputName ? 'input' : 'business';
    const row: Row = [safeCell(pick.e.name || pick.e.pageTitle || inputName || pick.r.business), email, pick.r.site, pick.e.link ?? ''];
    const onSites = new Set(seen.map((x) => regDomain(hostOf(x.r.finalUrl)))).size;
    if (!owner && onSites >= SHARED_MIN_SITES) {
      shared.push(row);
      sharedOn.set(email, onSites);
    } else {
      main.push({ ...pick, row });
      kinds[kind]++;
    }
  }
  main.sort((a, b) => a.si - b.si || a.ei - b.ei);
  return { rows: main.map((m) => m.row), shared, sharedOn, kinds };
}

/**
 * One row per email across several output CSVs (input lists overlap, so the same address shows up in many
 * files). Files are taken in the given order and the first occurrence wins, like buildRows within one file.
 */
export function uniqueRows(files: { base: string; rows: Row[] }[]): { rows: Row[]; read: number; overlaps: Map<string, number> } {
  const rows: Row[] = [];
  const firstIn = new Map<string, string>();
  const overlaps = new Map<string, number>(); // "later file ← first file" → duplicates dropped
  let read = 0;
  for (const f of files) {
    for (const row of f.rows) {
      read++;
      const key = row[1].trim().toLowerCase();
      const first = firstIn.get(key);
      if (first !== undefined) {
        if (first !== f.base) overlaps.set(`${f.base} ← ${first}`, (overlaps.get(`${f.base} ← ${first}`) ?? 0) + 1);
        continue;
      }
      firstIn.set(key, f.base);
      rows.push(row);
    }
  }
  return { rows, read, overlaps };
}

/** Name for a combined file: the prefix all base names share before their first `.`, `_` or `-` (`au.x`, `au.y` → `au`), else `all`. */
export function uniqueLabel(bases: string[]): string {
  const heads = new Set(bases.map((b) => b.split(/[._-]/)[0]));
  const [head] = heads;
  return heads.size === 1 && head ? head : 'all';
}
