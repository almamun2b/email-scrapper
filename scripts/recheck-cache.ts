/**
 * Shows what the current email/name rules would change in the cached results, without writing anything.
 * Use it after editing extract.ts (or the row assignment in output.ts) to review the effect on every real row
 * scraped so far.
 *
 *   npx tsx scripts/recheck-cache.ts            # all caches
 *   npx tsx scripts/recheck-cache.ts au.ford    # one file (or dealers/au.ford)
 *   npx tsx scripts/recheck-cache.ts --all      # print every change, not a sample
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCache } from '../src/cache.js';
import type { SiteResult } from '../src/crawler.js';
import { readSites } from '../src/input.js';
import { assignRows, recheckSite } from '../src/output.js';
import { IN_DIR, OUT_DIR } from '../src/paths.js';

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const only = args.filter((a) => !a.startsWith('--'));
const SAMPLE = 25;

// emails/<group>/.cache/<base>.jsonl; `id` is <group>/<base>
const files = fs.readdirSync(OUT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(OUT_DIR, d.name, '.cache')))
  .flatMap((d) => fs.readdirSync(path.join(OUT_DIR, d.name, '.cache'))
    .filter((f) => /^[^.]+(\.[^.]+)*\.jsonl$/.test(f) && !/\.\d{8}-\d{6}\.jsonl$/.test(f)) // skip rotated caches
    .map((f) => ({ group: d.name, base: f.replace(/\.jsonl$/, ''), file: path.join(OUT_DIR, d.name, '.cache', f) })))
  .map((c) => ({ ...c, id: `${c.group}/${c.base}` }))
  .filter((c) => !only.length || only.includes(c.id) || only.includes(c.base));

/** The input list for a cache, for its site order and name column; null when the input is gone. */
function inputOf(group: string, base: string) {
  for (const f of [path.join(IN_DIR, group, `${base}.csv`), path.join(IN_DIR, `${base}.csv`)]) {
    if (fs.existsSync(f)) {
      try { return readSites(f); } catch { return null; }
    }
  }
  return null;
}

/** What the CSV used to do: first site in input order wins, named by person, department, then business. */
function oldCredit(sites: string[], done: Map<string, SiteResult>): Map<string, string> {
  const credit = new Map<string, string>();
  for (const s of sites) for (const e of done.get(s)?.emails ?? []) if (!credit.has(e.email)) credit.set(e.email, s);
  return credit;
}

let rows = 0;
const dropped: string[] = [];
const decoded: string[] = [];
const nameLost: string[] = [];
const nameChanged: string[] = [];
const nameGained: string[] = [];
const moved: string[] = [];
const shared: string[] = [];
const named: string[] = [];

for (const { group, base, file, id } of files) {
  const done = loadCache(file);
  for (const r of done.values()) {
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

  // Row assignment for the whole file: which site an email is credited to, and what goes to shared/.
  const input = inputOf(group, base);
  const sites = input?.sites.filter((s) => done.has(s)) ?? [...done.keys()];
  const checked = new Map([...done].map(([s, r]) => [s, recheckSite(r)]));
  const before = oldCredit(sites, checked);
  const out = assignRows(sites, checked, input?.names);
  for (const [, email, site] of out.rows) {
    const was = before.get(email);
    if (was && was !== site) moved.push(`${id}: ${email}  ${new URL(was).hostname} → ${new URL(site).hostname}`);
  }
  for (const [, email] of out.shared) shared.push(`${id}: ${email} (on ${out.sharedOn.get(email)} sites)`);
  if (out.kinds.input) named.push(`${id}: ${out.kinds.input} row(s) now named from the input's name column`);
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
show('Emails credited to a different site', moved);
show('Emails moved to shared/', shared);
show('Input names used', named);
