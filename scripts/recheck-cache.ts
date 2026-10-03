/**
 * Shows what the current email/name rules would change in the cached results, without writing anything.
 * Use it after editing extract.ts to review the effect on every real row scraped so far.
 *
 *   npx tsx scripts/recheck-cache.ts            # all caches
 *   npx tsx scripts/recheck-cache.ts au.ford    # one file
 *   npx tsx scripts/recheck-cache.ts --all      # print every change, not a sample
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SiteResult } from '../src/crawler.js';
import { recheckSite } from '../src/output.js';

const CACHE_DIR = path.resolve(import.meta.dirname, '..', 'emails', '.cache');
const args = process.argv.slice(2);
const showAll = args.includes('--all');
const only = args.filter((a) => !a.startsWith('--'));
const SAMPLE = 25;

const files = fs.readdirSync(CACHE_DIR)
  .filter((f) => /^[^.]+(\.[^.]+)*\.jsonl$/.test(f) && !/\.\d{8}-\d{6}\.jsonl$/.test(f)) // skip rotated caches
  .filter((f) => !only.length || only.includes(f.replace(/\.jsonl$/, '')));

let rows = 0;
const dropped: string[] = [];
const decoded: string[] = [];
const nameLost: string[] = [];
const nameChanged: string[] = [];
const nameGained: string[] = [];

for (const f of files) {
  for (const line of fs.readFileSync(path.join(CACHE_DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: SiteResult;
    try { r = JSON.parse(line); } catch { continue; }
    const after = new Map(recheckSite(r).emails.map((e) => [e.email, e]));
    const used = new Set<string>();
    for (const e of r.emails) {
      rows++;
      let now = after.get(e.email);
      if (!now) {
        const match = [...after.values()].find((a) => !used.has(a.email) && !r.emails.some((o) => o.email === a.email));
        if (match) { used.add(match.email); decoded.push(`${e.email} → ${match.email}`); now = match; } else { dropped.push(e.email); continue; }
      }
      if (e.name && !now.name) nameLost.push(`${e.email}: "${e.name}"`);
      else if (!e.name && now.name) nameGained.push(`${e.email}: "${now.name}"`);
      else if (e.name && now.name && e.name !== now.name) nameChanged.push(`${e.email}: "${e.name}" → "${now.name}"`);
    }
  }
}

const show = (title: string, list: string[]) => {
  console.log(`\n${title}: ${list.length}`);
  for (const l of showAll ? list : list.slice(0, SAMPLE)) console.log('  ' + l);
  if (!showAll && list.length > SAMPLE) console.log(`  … ${list.length - SAMPLE} more (--all to list)`);
};
console.log(`${files.length} cache file(s), ${rows} email rows`);
show('Emails dropped', dropped);
show('Emails decoded (ROT13)', decoded);
show('Person names removed', nameLost);
show('Person names changed', nameChanged);
show('Person names added', nameGained);
