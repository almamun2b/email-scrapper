import type { FoundOnPage, SiteResult } from './crawler.js';
import { demoteRolePrefixes, recheckRow } from './extract.js';

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
  return { ...r, emails };
}

/** CSV rows in input-site order, unique by email (first site wins). */
export function buildRows(sites: string[], done: Map<string, SiteResult>): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const r = done.get(site);
    if (!r) continue;
    for (const e of r.emails) {
      if (seen.has(e.email)) continue;
      seen.add(e.email);
      rows.push([safeCell(e.name || e.pageTitle || r.business), e.email, r.site, e.link ?? '']);
    }
  }
  return rows;
}
