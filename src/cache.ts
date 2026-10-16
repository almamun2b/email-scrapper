import fs from 'node:fs';
import path from 'node:path';
import type { ResumeParts, SiteResult } from './crawler.js';
import { log } from './logger.js';

/**
 * Per-input-file state in results/<group>/.cache/:
 * - <base>.jsonl       one SiteResult per line, appended as sites finish (the only file the loaders read)
 * - <base>.inprogress  a scrape started and hasn't written its CSV yet; the next run resumes instead of resetting
 * - <base>.lock        PID of the run working on this file
 * - <base>.<stamp>.jsonl  an earlier run's cache, rotated aside by a fresh re-scrape (never deleted)
 */
export interface CacheFiles {
  cache: string;
  marker: string;
  lock: string;
}

export function cacheFiles(cacheDir: string, base: string): CacheFiles {
  return {
    cache: path.join(cacheDir, `${base}.jsonl`),
    marker: path.join(cacheDir, `${base}.inprogress`),
    lock: path.join(cacheDir, `${base}.lock`),
  };
}

/**
 * A run cut off at the wrong moment can leave the last record unfinished or without its newline (or followed
 * by NUL bytes after an unclean shutdown), and the next run's append then lands on the same line. Every record
 * starts with `{"v":` (older ones with `{"site":`). That can't occur inside a record: a quote in a string is
 * escaped, and nested objects have other keys. So it marks where the next record begins.
 */
const RECORD_START = /(?=\{"(?:v|site)":)/;

/** Cached results by site; unreadable records are skipped (those sites get scraped again). */
export function loadCache(file: string): Map<string, SiteResult> {
  const done = new Map<string, SiteResult>();
  if (!fs.existsSync(file)) return done;
  for (const [i, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as SiteResult;
      done.set(r.site, r);
      continue;
    } catch {
      // fall through: salvage the records glued together on this line
    }
    for (const part of line.replace(/\0+/g, '').split(RECORD_START)) {
      if (!part.trim()) continue;
      try {
        const r = JSON.parse(part) as SiteResult;
        done.set(r.site, r);
      } catch (err) {
        log.warn({ err, cacheFile: file, line: i + 1 }, `skipping an unreadable record on line ${i + 1} of ${path.basename(file)}; its site will be scraped again`);
      }
    }
  }
  return done;
}

/** Makes sure the next append starts on a fresh line, even if an interrupted run left the last one unfinished. */
export function ensureTrailingNewline(file: string): void {
  if (!fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  if (!size) return;
  const fd = fs.openSync(file, 'r');
  const last = Buffer.alloc(1);
  try {
    fs.readSync(fd, last, 0, 1, size - 1);
  } finally {
    fs.closeSync(fd);
  }
  if (last[0] !== 0x0a) fs.appendFileSync(file, '\n');
}

// None of the retries touches a robots.txt block: that won't change.

/** --retry-failed: a failure with nothing found. */
export function failedRetry(r: SiteResult): boolean {
  return !!r.error && r.error !== 'robots-disallowed' && r.emails.length === 0;
}

/** --retry-rate-limited: pages the server refused with 429/503. v3 rows list them; older rows only count them. */
export function rateLimitedRetry(r: SiteResult): boolean {
  if (r.error === 'robots-disallowed') return false;
  return (r.v ?? 0) >= 3 ? !!r.resume?.limited.length : (r.rateLimited ?? 0) > 0;
}

/** --retry-budget-queued: the time budget ran out with pages still queued, or before the browser phase ran. */
export function budgetRetry(r: SiteResult): boolean {
  if (r.error === 'robots-disallowed') return false;
  return (r.budgetQueued ?? 0) > 0 || (!!r.resume?.queued.length && !r.resume.capped) || !!r.resume?.browser;
}

/** --retry-capped: the page cap (--max-pages) was reached with pages still queued (v3 rows only). */
export function cappedRetry(r: SiteResult): boolean {
  if (r.error === 'robots-disallowed') return false;
  return !!r.resume?.capped && r.resume.queued.length > 0;
}

export interface RetryFlags {
  failed: boolean;
  rateLimited: boolean;
  budget: boolean;
  capped?: boolean;
}

export interface RetryPlan {
  recrawl: Set<string>; // crawled again from the start
  resume: Map<string, ResumeParts>; // continued from their saved state (resumeSite)
  previous: Map<string, SiteResult>; // re-crawled rows with emails: kept, plus the new emails a re-crawl finds (mergeResults)
}

/**
 * Which cached sites a retry run redoes, and how. A failure is crawled again from the start. Rate-limited
 * pages and a queue left by the time budget are continued from the row's saved state; a row without one
 * (scraped before v3, or marked from the logs) is crawled again instead; its row is kept and only new emails are added.
 */
export function planRetries(done: Map<string, SiteResult>, flags: RetryFlags): RetryPlan {
  const plan: RetryPlan = { recrawl: new Set(), resume: new Map(), previous: new Map() };
  for (const [site, r] of done) {
    if (flags.failed && failedRetry(r)) {
      plan.recrawl.add(site);
      continue;
    }
    const parts: ResumeParts = { budget: flags.budget && budgetRetry(r), limited: flags.rateLimited && rateLimitedRetry(r), capped: !!flags.capped && cappedRetry(r) };
    if (!parts.budget && !parts.limited && !parts.capped) continue;
    const s = r.resume;
    // A capped row always has its queue saved, so only the other parts can send a row back to a full re-crawl.
    const saved = (!parts.budget || !!((s?.queued.length && !s.capped) || s?.browser || (s?.capped && parts.capped))) && (!parts.limited || !!s?.limited.length);
    if (saved) {
      plan.resume.set(site, parts);
    } else {
      plan.recrawl.add(site);
      if (r.emails.length) plan.previous.set(site, r);
    }
  }
  return plan;
}

/**
 * Replaces a file via a temp file and rename, so a crash never leaves it truncated. Outputs hold personal data,
 * so a new file is readable by its owner only (an existing file keeps its mode).
 */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = file + '.tmp';
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode); // the umask may have narrowed it
  fs.renameSync(tmp, file);
}

/** Replaces the cache file atomically (see writeFileAtomic). */
export function writeCacheAtomic(file: string, results: Iterable<SiteResult>): void {
  writeFileAtomic(file, [...results].map((r) => JSON.stringify(r) + '\n').join(''));
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261003-213500
}

/**
 * Called before scraping a file. Resumes when an earlier scrape of it was interrupted (marker present).
 * Otherwise a finished earlier run (output CSV exists) has its cache renamed aside, so it is kept but not
 * reused, unless keepCache is set (the --retry-* runs build on the existing cache).
 */
export function beginScrape(files: CacheFiles, outputExists: boolean, keepCache = false): { resumed: boolean; rotatedTo?: string } {
  if (fs.existsSync(files.marker)) return { resumed: true };
  let rotatedTo: string | undefined;
  if (outputExists && !keepCache && fs.existsSync(files.cache)) {
    rotatedTo = files.cache.replace(/\.jsonl$/, `.${stamp()}.jsonl`);
    fs.renameSync(files.cache, rotatedTo);
  }
  fs.writeFileSync(files.marker, `${process.pid} ${new Date().toISOString()}\n`);
  return { resumed: false, rotatedTo };
}

export function endScrape(files: CacheFiles): void {
  fs.rmSync(files.marker, { force: true });
}

export class LockedError extends Error {}

const heldLocks = new Set<string>();
let exitHookInstalled = false;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the per-file lock or throws if another live run holds it. Returns the release function. */
export function acquireLock(lockFile: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw err;
      const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
      if (pid && pid !== process.pid && pidAlive(pid)) {
        throw new LockedError(`${path.basename(lockFile, '.lock')} is in use by another run (pid ${pid}); wait for it or kill it first`);
      }
      log.warn({ lockFile, pid }, `taking over ${path.basename(lockFile)}: the run that held it (pid ${pid}) is gone`);
      fs.rmSync(lockFile, { force: true });
    }
  }
  heldLocks.add(lockFile);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // process.exit (also used by the signal handlers) runs 'exit' listeners synchronously
    process.on('exit', () => { for (const l of heldLocks) fs.rmSync(l, { force: true }); });
  }
  return () => {
    heldLocks.delete(lockFile);
    fs.rmSync(lockFile, { force: true });
  };
}
