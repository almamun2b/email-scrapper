import { getPublicSuffix } from 'tldts';
import type { Row } from './output.js';

/** Which emails to keep, by the ending of their domain. Applied to outputs only; the cache always holds every email. */
export interface SuffixFilter {
  include: string[]; // keep only emails whose domain ends with one of these (empty = no restriction)
  exclude: string[]; // drop emails whose domain ends with one of these
}

const SUFFIX = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * The suffixes in one flag value: comma-separated, case-insensitive, leading dot optional, empty entries ignored
 * (`.com, .net,` → `com`, `net`). Throws on anything that can't end a domain name.
 */
export function parseSuffixes(raw: string, flag: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim().toLowerCase().replace(/^\./, '');
    if (!s) continue;
    if (!SUFFIX.test(s)) throw new Error(`--${flag}: "${part.trim()}" is not a domain suffix (expected something like .com or .gov.au)`);
    out.push(s);
  }
  return out;
}

/** `au` matches `x.com.au` and `au` itself, never `x.nau`; `gov` does not match `x.gov.au`. */
export function matchesSuffix(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');

/** An email stays when it matches an include suffix (if any are given) and no exclude suffix. */
export function keepEmail(email: string, f: SuffixFilter): boolean {
  const d = domainOf(email);
  if (f.exclude.some((s) => matchesSuffix(d, s))) return false;
  return !f.include.length || f.include.some((s) => matchesSuffix(d, s));
}

/** Same filter in any order or spelling gives the same tag, so its output file is the same file. */
export function filterTag(f: SuffixFilter): string {
  const part = (kind: string, list: string[]) => (list.length ? `${kind}-suffix-${[...new Set(list)].sort().join('-')}` : '');
  return [part('include', f.include), part('exclude', f.exclude)].filter(Boolean).join('_');
}

/** For logs: `include .au, .nz; exclude .gov.au`. */
export function describeFilter(f: SuffixFilter): string {
  const part = (kind: string, list: string[]) => (list.length ? `${kind} ${[...new Set(list)].sort().map((s) => `.${s}`).join(', ')}` : '');
  return [part('include', f.include), part('exclude', f.exclude)].filter(Boolean).join('; ');
}

/** The rows that pass the filter, and how many were dropped per domain ending (`com.au` → 12), for the summary. */
export function filterRows(rows: Row[], f: SuffixFilter): { kept: Row[]; dropped: Map<string, number> } {
  const kept: Row[] = [];
  const dropped = new Map<string, number>();
  for (const row of rows) {
    if (keepEmail(row[1], f)) { kept.push(row); continue; }
    const d = domainOf(row[1]);
    const ending = getPublicSuffix(d) ?? d.slice(d.lastIndexOf('.') + 1);
    dropped.set(ending, (dropped.get(ending) ?? 0) + 1);
  }
  return { kept, dropped };
}

/** A summary block for a filtered file: `Emails : 120 of 241 kept -> path` and what was dropped. */
export function filterSummary(label: string, f: SuffixFilter, total: number, kept: number, dropped: Map<string, number>, outRel: string): string {
  const top = [...dropped].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([k, n]) => `${k} ${n}`);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [
    `[${stamp}] ${label} filtered (${describeFilter(f)})`,
    `  Emails   : ${kept} of ${total} kept -> ${outRel}`,
    ...(total - kept ? [`  Dropped  : ${total - kept} (${top.join(', ')}${dropped.size > top.length ? ', …' : ''})`] : []),
    '',
  ].join('\n');
}
