/**
 * Marks cached sites that ran out of time budget before the cache recorded it (rows older than v3), using the
 * "time budget used up" / "stopped at the hard time limit" lines in logs/scraper-*.log, so that
 * `--retry-budget-queued` picks them up. Their queue was never saved, so that retry crawls them again from the
 * start and keeps the earlier result if it finds fewer emails.
 *
 *   npx tsx scripts/mark-budget-from-logs.ts           # show what would be marked; writes nothing
 *   npx tsx scripts/mark-budget-from-logs.ts --write   # append the marked rows to the caches
 *
 * A row is marked only if its page count still matches the log line, so a site scraped again since is left
 * alone. Marked rows are appended (the last line wins), so nothing in a cache is rewritten or deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock, cacheFiles, ensureTrailingNewline, loadCache, LockedError } from '../src/cache.js';
import type { SiteResult } from '../src/crawler.js';
import { LOG_DIR } from '../src/logger.js';
import { fileLayout, OUT_DIR, ROOT } from '../src/paths.js';

export interface BudgetHit {
  file: string; // the log's `file` field: <group>/<base>, or just <base> before category folders
  site: string;
  pages: number;
  queued: number;
  time: string;
}

const TIME_LIMIT = /time budget used up|stopped at the hard time limit/;

/** The latest time-limit line per file and site, from scraper log lines. */
export function budgetHits(lines: Iterable<string>): BudgetHit[] {
  const latest = new Map<string, BudgetHit>();
  for (const line of lines) {
    if (!TIME_LIMIT.test(line)) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const { file, site, pages, queued, time } = j;
    if (typeof file !== 'string' || typeof site !== 'string' || typeof pages !== 'number' || typeof queued !== 'number' || typeof time !== 'string') continue;
    const key = `${file}\n${site}`;
    const prev = latest.get(key);
    if (!prev || prev.time < time) latest.set(key, { file, site, pages, queued, time });
  }
  return [...latest.values()];
}

/** `<group>/<base>` for a log's file field; a bare base resolves only if exactly one group's cache has it. */
export function resolveCacheId(file: string, groupsByBase: Map<string, string[]>): string | null {
  if (file.includes('/')) return file;
  const groups = groupsByBase.get(file) ?? [];
  return groups.length === 1 ? `${groups[0]}/${file}` : null;
}

/** The cached row with its queue count added, or why it is left alone. */
export function markRow(r: SiteResult | undefined, hit: BudgetHit): { row: SiteResult } | { skip: string } {
  if (!r) return { skip: 'not in the cache' };
  if (r.budgetQueued || r.resume) return { skip: 'already marked' };
  if ((r.v ?? 0) >= 3) return { skip: 'scraped again since' };
  if (r.error === 'robots-disallowed') return { skip: 'robots-disallowed' };
  const same = r.pages === hit.pages || (r.usedBrowser && r.pages >= hit.pages);
  if (!same) return { skip: `scraped again since (${r.pages} pages now, ${hit.pages} then)` };
  return { row: { ...r, budgetQueued: hit.queued } };
}

function main(): void {
  const write = process.argv.includes('--write');
  const logs = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => /^scraper-.*\.log$/.test(f)).sort() : [];
  const hits = budgetHits(logs.flatMap((f) => fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')));
  if (!hits.length) {
    console.log('No "time budget used up" lines in logs/scraper-*.log; nothing to mark.');
    return;
  }

  const groupsByBase = new Map<string, string[]>();
  for (const d of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR, { withFileTypes: true }) : []) {
    const dir = path.join(OUT_DIR, d.name, '.cache');
    if (!d.isDirectory() || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl') || /\.\d{8}-\d{6}\.jsonl$/.test(f)) continue; // skip rotated caches
      const base = f.slice(0, -'.jsonl'.length);
      groupsByBase.set(base, [...(groupsByBase.get(base) ?? []), d.name]);
    }
  }

  const byCache = new Map<string, BudgetHit[]>();
  for (const h of hits) {
    const id = resolveCacheId(h.file, groupsByBase);
    if (!id) {
      console.log(`  ? ${h.file}: no single cache found for this log entry (${h.site})`);
      continue;
    }
    byCache.set(id, [...(byCache.get(id) ?? []), h]);
  }

  let marked = 0;
  const toRetry: string[] = [];
  for (const [id, list] of [...byCache].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [group, base] = id.split('/');
    const cf = cacheFiles(fileLayout(group, base).cacheDir, base);
    console.log(`\n${id}  (${path.relative(ROOT, cf.cache)})`);
    if (!fs.existsSync(cf.cache)) { console.log('  no cache file; skipped'); continue; }
    if (fs.existsSync(cf.marker)) { console.log('  a scrape of this file is running or was interrupted; skipped (run this again once it has finished)'); continue; }
    let release: (() => void) | undefined;
    if (write) {
      try {
        release = acquireLock(cf.lock);
      } catch (err) {
        if (!(err instanceof LockedError)) throw err;
        console.log(`  ${err.message}; skipped`);
        continue;
      }
    }
    try {
      const done = loadCache(cf.cache);
      const rows: SiteResult[] = [];
      for (const h of list) {
        const m = markRow(done.get(h.site), h);
        if ('row' in m) rows.push(m.row);
        console.log(`  ${'row' in m ? 'mark' : 'skip'}  ${h.site}  (${h.pages} pages, ${h.queued} queued, ${h.time.slice(0, 10)})${'skip' in m ? `: ${m.skip}` : ''}`);
      }
      if (rows.length) toRetry.push(id);
      marked += rows.length;
      if (write && rows.length) {
        ensureTrailingNewline(cf.cache);
        fs.appendFileSync(cf.cache, rows.map((r) => JSON.stringify(r) + '\n').join(''));
      }
    } finally {
      release?.();
    }
  }

  console.log(`\n${marked} site(s) ${write ? 'marked' : 'would be marked'}.`);
  if (marked && !write) console.log('Run again with --write to append them to the caches.');
  if (marked && write) {
    console.log('Continue them with, for example:');
    for (const id of toRetry) console.log(`  npm run scrape -- websites/${id}.csv --retry-budget-queued=60`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
