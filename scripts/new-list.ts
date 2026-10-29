/**
 * Turns a CSV of candidate sites into a new list file in a category folder, never touching the existing ones:
 * the file is `<list>.<cc>.csv` if the category has no such list, else `<list>-2.<cc>.csv`, `-3`, ... It holds
 * only sites that are in no CSV of the category yet (same host + path as `readSites()` dedupes) and are not
 * ordering platforms, social pages or directories.
 *
 *   npx tsx scripts/new-list.ts <category> <list> <cc> <candidates.csv> [--dry-run]
 *   npx tsx scripts/new-list.ts pizza-au pizza-shops au /scratch/au.candidates.csv --dry-run
 *
 * The candidates need a website column (same detection as any input list) and may have a name column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { getDomain } from 'tldts';
import { readSites, siteKey } from '../src/input.js';
import { IN_DIR } from '../src/paths.js';

/** Registrable domains that are never a business's own site: ordering, social, review and directory platforms. */
export const BLOCKED_DOMAINS = new Set([
  'ubereats.com', 'menulog.com.au', 'menulog.co.nz', 'doordash.com', 'deliveroo.com.au', 'deliveroo.co.nz', 'foodora.com', 'order.online',
  'dineplan.com', 'opentable.com', 'opentable.com.au', 'thefork.com', 'zomato.com', 'resdiary.com', 'sevenrooms.com', 'bookenzy.com',
  'facebook.com', 'fb.com', 'instagram.com', 'linktr.ee', 'linktree.com', 'tiktok.com', 'twitter.com', 'x.com', 'youtube.com', 'pinterest.com',
  'linkedin.com', 'google.com', 'goo.gl', 'g.page', 'business.site', 'tripadvisor.com', 'tripadvisor.com.au', 'tripadvisor.co.nz', 'yelp.com',
  'yellowpages.com.au', 'yellowpages.co.nz', 'truelocal.com.au', 'hotfrog.com.au', 'hotfrog.co.nz', 'localsearch.com.au', 'localsearch.co.nz',
  'wikipedia.org', 'wikidata.org', 'openstreetmap.org', 'booking.com', 'eatclub.com.au', 'hungryhungry.com', 'mealme.ai', 'wixsite.com',
]);

export function isBlocked(url: string): boolean {
  const d = getDomain(new URL(url).hostname);
  return !!d && BLOCKED_DOMAINS.has(d);
}

/** The next free file name for `list` in `dir`: the unnumbered file counts as 1, so the first new one is `-2`. */
export function nextListName(dir: string, list: string, cc: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(list)}(?:-(\\d+))?\\.${esc(cc)}\\.csv$`, 'i');
  let max = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = re.exec(f);
    if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
  }
  return max === 0 ? `${list}.${cc}.csv` : `${list}-${max + 1}.${cc}.csv`;
}

export interface NewList {
  file: string;
  rows: { name: string; website: string }[];
  candidates: number;
  invalid: number;
  blocked: number;
  known: number; // already in a CSV of the category
  repeated: number; // twice among the candidates
}

export function buildList(dir: string, list: string, cc: string, candidatesFile: string): NewList {
  const known = new Set<string>();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv')) : []) {
    for (const s of readSites(path.join(dir, f)).sites) known.add(siteKey(s));
  }
  const input = readSites(candidatesFile);
  const out: NewList = { file: path.join(dir, nextListName(dir, list, cc)), rows: [], candidates: input.sites.length + input.duplicates, invalid: input.invalid, blocked: 0, known: 0, repeated: input.duplicates };
  for (const s of input.sites) {
    if (isBlocked(s)) { out.blocked++; continue; }
    const k = siteKey(s);
    if (known.has(k)) { out.known++; continue; }
    known.add(k);
    const url = new URL(s);
    url.hash = '';
    out.rows.push({ name: input.names.get(s) ?? url.hostname.replace(/^www\./, ''), website: url.toString().replace(/\/$/, '') });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const [category, list, cc, candidates] = args.filter((a) => !a.startsWith('--'));
  if (!category || !list || !cc || !candidates) {
    console.error('usage: new-list.ts <category> <list> <cc> <candidates.csv> [--dry-run]');
    process.exit(2);
  }
  const r = buildList(path.join(IN_DIR, category), list, cc, candidates);
  console.log(`${r.file}: ${r.rows.length} new sites from ${r.candidates} candidates (invalid ${r.invalid}, blocked platforms ${r.blocked}, already in the category ${r.known}, repeated ${r.repeated})`);
  if (!dry && r.rows.length) {
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, stringify(r.rows, { header: true, columns: ['name', 'website'] }));
    console.log('written');
  } else if (dry) console.log('dry run: nothing written');
}
