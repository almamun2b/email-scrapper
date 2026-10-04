import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'csv-stringify/sync';
import pLimit from 'p-limit';
import type { LevelWithSilent } from 'pino';
import { acquireLock, beginScrape, cacheFiles, endScrape, ensureTrailingNewline, isRetryable, loadCache, LockedError, writeCacheAtomic } from './cache.js';
import { parseArgs, rawFlag } from './cli.js';
import { CACHE_VERSION, closeBrowser, DEFAULT_OPTIONS, QUICK_OPTIONS, scrapeSite, setHostConcurrency, type CrawlOptions, type SiteResult } from './crawler.js';
import { readSites } from './input.js';
import { initFileLogging, installProcessHandlers, log, LOG_DIR, parseLevel, runId, withLogContext } from './logger.js';
import { buildRows, recheckSite } from './output.js';
import { baseHost } from './urls.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const IN_DIR = path.join(ROOT, 'websites');
const OUT_DIR = path.join(ROOT, 'emails');
const CACHE_DIR = path.join(OUT_DIR, '.cache');
const SUMMARY_DIR = path.join(OUT_DIR, 'logs'); // per-file run summaries; diagnostics go to <root>/logs
const HARD_TIMEOUT_EXTRA_MS = 4 * 60_000; // hard safety net on top of scrapeSite's soft budget, which keeps partial results
const STOP_GRACE_MS = 30_000;

interface RunOptions extends CrawlOptions {
  concurrency: number; // sites in parallel
  hostConcurrency: number; // parallel requests to one server across all sites
}

/**
 * Scrapes one site under a hard time limit. At the limit the scrape is aborted and has STOP_GRACE_MS to
 * return what it found; only a scrape that won't stop (or crashes) falls back to an empty result.
 * Never rejects, so one broken site never stops the run.
 */
function runSite(site: string, opts: RunOptions): Promise<SiteResult> {
  const limitMs = opts.budgetMs + HARD_TIMEOUT_EXTRA_MS;
  const empty = (error: string): SiteResult => ({
    v: CACHE_VERSION, site, finalUrl: site, business: baseHost(new URL(site).hostname), emails: [], pages: 0, usedBrowser: false, error,
  });
  return new Promise((resolve) => {
    const ctl = new AbortController();
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (r: SiteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(grace);
      resolve(r);
    };
    const hard = setTimeout(() => {
      log.warn({ timeoutMs: limitMs }, `stopped after the ${Math.round(limitMs / 60_000)}-minute hard limit; keeping what it found`);
      ctl.abort();
      grace = setTimeout(() => {
        log.warn({ graceMs: STOP_GRACE_MS }, `did not stop within ${STOP_GRACE_MS / 1000} s after the hard limit; its partial results are lost`);
        finish(empty('timeout'));
      }, STOP_GRACE_MS);
    }, limitMs);
    scrapeSite(site, opts, ctl.signal).then(finish, (err) => {
      log.error({ err }, 'scraper bug while crawling this site (recorded as internal-error); stack trace in logs/error-<date>.log');
      finish(empty('internal-error'));
    });
  });
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

const REASON_CODES = new Set(['unreachable', 'robots-disallowed', 'timeout', 'browser-error', 'internal-error']);

/** Failure reason for the summary's counts: older cache lines can hold raw exception text. */
function reasonCode(error: string): string {
  return REASON_CODES.has(error) ? error : 'other';
}

/** Human-readable summary of one processed CSV; printed and appended to emails/logs/<name>.log. */
function describe(o: RunOptions): string {
  return `${o.maxPages} pages, ${o.browserPages} browser pages, depth ${o.maxDepth || 'unlimited'}, ${o.budgetMs / 60_000} min/site, ${o.concurrency} sites in parallel, ${o.pageConcurrency} page requests per site, ${o.hostConcurrency} per server`;
}

function writeSummary(base: string, sites: string[], done: Map<string, SiteResult>, uniqueEmails: number, mode: string, startedAt: number): void {
  const results = sites.map((s) => done.get(s)).filter((r): r is SiteResult => !!r);
  const withEmails = results.filter((r) => r.emails.length > 0);
  const noEmails = results.filter((r) => !r.emails.length && !r.error);
  const failed = results.filter((r) => !r.emails.length && r.error);
  const reasons = new Map<string, number>();
  for (const r of failed) {
    const reason = reasonCode(r.error!);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const partial = results.filter((r) => r.emails.length && r.error);
  const seen = new Set<string>();
  let persons = 0;
  let departments = 0;
  for (const r of results) for (const e of r.emails) {
    if (seen.has(e.email)) continue;
    seen.add(e.email);
    if (e.name) persons++;
    else if (e.pageTitle) departments++;
  }
  const host = (r: SiteResult) => baseHost(new URL(r.site).hostname);
  const top = [...withEmails].sort((a, b) => b.emails.length - a.emails.length).slice(0, 5);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const missing = sites.length - results.length;
  const lines = [
    `[${stamp}] ${base}.csv  (${mode}, took ${fmtDuration(Date.now() - startedAt)})`,
    `  Websites : ${sites.length} total | ${withEmails.length} with emails | ${noEmails.length} no emails found | ${failed.length} failed`,
    `  Emails   : ${uniqueEmails} unique (${persons} person name, ${departments} department page title, ${uniqueEmails - persons - departments} business name)`,
    `  Crawl    : ${results.reduce((n, r) => n + r.pages, 0)} pages fetched | headless browser used on ${results.filter((r) => r.usedBrowser).length} sites`,
  ];
  if (missing) lines.push(`  Missing  : ${missing} site(s) not in the cache yet (not scraped)`);
  if (reasons.size) lines.push(`  Failures : ${[...reasons].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (partial.length) lines.push(`  Partial  : ${partial.length} site(s) hit an error/time limit but kept what was found`);
  const limited = results.filter((r) => r.rateLimited);
  if (limited.length) {
    const pages = limited.reduce((n, r) => n + r.rateLimited!, 0);
    const worst = [...limited].sort((a, b) => b.rateLimited! - a.rateLimited!).slice(0, 5).map((r) => `${host(r)} (${r.rateLimited})`);
    lines.push(`  Limited  : ${pages} page(s) skipped on ${limited.length} site(s) because the server rate-limited the scraper (HTTP 429/503): ${worst.join(', ')}`);
  }
  if (top.length) lines.push(`  Top sites: ${top.map((r) => `${host(r)} (${r.emails.length})`).join(', ')}`);
  if (failed.length) lines.push(`  Failed sites:\n${failed.map((r) => `    - ${host(r)} [${r.error}]`).join('\n')}`);
  if (noEmails.length) lines.push(`  No emails found on:\n${noEmails.map((r) => `    - ${host(r)}`).join('\n')}`);
  const text = lines.join('\n') + '\n';
  fs.mkdirSync(SUMMARY_DIR, { recursive: true });
  fs.appendFileSync(path.join(SUMMARY_DIR, `${base}.log`), text + '\n');
  log.info({ sites: sites.length, withEmails: withEmails.length, noEmails: noEmails.length, failed: failed.length, uniqueEmails, failures: Object.fromEntries(reasons) }, '\n' + text);
}

async function processFile(file: string, opts: RunOptions, retryFailed: boolean, summaryOnly = false): Promise<void> {
  const startedAt = Date.now();
  const base = path.basename(file, path.extname(file));
  const outFile = path.join(OUT_DIR, `${base}.csv`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cf = cacheFiles(CACHE_DIR, base);
  const rel = (f: string) => path.relative(ROOT, f);

  if (summaryOnly) {
    if (fs.existsSync(cf.marker)) {
      log.warn({ input: rel(file) }, `Skipping ${base}: its last scrape was interrupted. Resume it first (re-run the scrape), then rebuild`);
      return;
    }
    if (!fs.existsSync(cf.cache) || !fs.statSync(cf.cache).size) {
      log.warn({ input: rel(file), cacheFile: rel(cf.cache) }, `Skipping ${base}: no cache to rebuild from, so ${rel(outFile)} is left untouched`);
      return;
    }
  }

  const release = acquireLock(cf.lock);
  try {
    const input = readSites(file);
    const { sites } = input;
    if (input.invalid || input.duplicates) {
      log.warn({ input: rel(file), invalid: input.invalid, duplicates: input.duplicates, column: input.column }, `${base}: skipped ${input.invalid} invalid and ${input.duplicates} duplicate website row(s)`);
    }
    if (!sites.length) {
      log.warn({ input: rel(file), column: input.column }, `${base}: no websites found in the input (looked in column ${input.column + 1})`);
      return;
    }

    if (!summaryOnly) {
      const { resumed, rotatedTo } = beginScrape(cf, fs.existsSync(outFile), retryFailed);
      if (resumed) log.info({ cacheFile: rel(cf.cache) }, `${base}: resuming an interrupted scrape from the cache`);
      if (rotatedTo) log.info({ previousCache: rel(rotatedTo) }, `${base}: previous cache kept as ${rel(rotatedTo)}`);
      ensureTrailingNewline(cf.cache);
    }
    const done = loadCache(cf.cache);
    // Results being retried that found emails: a retry that finds fewer (rate-limited again) keeps these.
    const previous = new Map<string, SiteResult>();
    if (retryFailed) {
      for (const [site, r] of done) {
        if (!isRetryable(r)) continue;
        if (r.emails.length) previous.set(site, r);
        done.delete(site);
      }
      // Earlier results stay in the file (a later line wins in loadCache), so an interrupted retry loses nothing.
      writeCacheAtomic(cf.cache, [...previous.values(), ...done.values()]);
    }
    log.info({ input: rel(file), sites: sites.length, cached: done.size }, `\n=== ${base}: ${sites.length} sites (${done.size} cached) ===`);

    let n = sites.filter((s) => done.has(s)).length;
    const limit = pLimit(opts.concurrency);
    await Promise.all(
      sites.map((site) =>
        limit(() => withLogContext({ site }, async () => {
          if (done.has(site) || summaryOnly) return;
          const t0 = Date.now();
          log.debug('site started');
          let r = await runSite(site, opts);
          const prev = previous.get(site);
          if (prev && r.emails.length < prev.emails.length) {
            log.info({ emails: r.emails.length, previousEmails: prev.emails.length }, `retry found ${r.emails.length} emails, fewer than the ${prev.emails.length} before; keeping the earlier result`);
            r = prev;
          }
          done.set(site, r);
          fs.appendFileSync(cf.cache, JSON.stringify(r) + '\n');
          n++;
          const ms = Date.now() - t0;
          const fields = { finalUrl: r.finalUrl, emails: r.emails.length, pages: r.pages, usedBrowser: r.usedBrowser, error: r.error, durationMs: ms };
          const msg = `[${n}/${sites.length}] ${baseHost(new URL(site).hostname)} — ${r.emails.length} emails, ${r.pages} pages${r.usedBrowser ? ', browser' : ''}${r.rateLimited ? `, ${r.rateLimited} pages rate-limited` : ''}${r.error ? `, ${r.error}` : ''} (${(ms / 1000).toFixed(0)}s)`;
          if (r.error && !r.emails.length) log.warn(fields, msg);
          else log.info(fields, msg);
        })),
      ),
    );

    // Outputs use the current rules even for cached rows; the cache file keeps what was scraped.
    const checked = new Map([...done].map(([site, r]) => [site, recheckSite(r)]));
    const rows = buildRows(sites, checked);
    fs.writeFileSync(outFile, stringify(rows, { header: true, columns: ['name', 'email', 'website', 'link'] }));
    const withEmails = sites.filter((s) => (checked.get(s)?.emails.length ?? 0) > 0).length;
    const failed = sites.filter((s) => { const r = checked.get(s); return r?.error && !r.emails.length; }).length;
    log.info({ output: rel(outFile), emails: rows.length, withEmails, failed }, `=> ${rel(outFile)}: ${rows.length} emails from ${withEmails}/${sites.length} sites (${failed} failed/unreachable)`);
    const mode = summaryOnly ? 'summary rebuilt from cache' : `${retryFailed ? 'retry-failed' : 'scrape'}: ${describe(opts)}`;
    writeSummary(base, sites, checked, rows.length, mode, startedAt);
    if (!summaryOnly) endScrape(cf);
  } finally {
    release();
  }
}

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  // File logging starts before the other flags are validated, so a bad command line is logged too.
  let level: LevelWithSilent = 'info';
  let levelError: unknown;
  try {
    level = parseLevel(rawFlag(argv, 'log-level')) ?? parseLevel(process.env.LOG_LEVEL) ?? 'info';
  } catch (err) {
    levelError = err;
  }
  initFileLogging(level);
  if (levelError) throw levelError;
  const { flags, values, files: fileArgs } = parseArgs(argv);
  const force = flags.has('force');
  const retryFailed = flags.has('retry-failed');
  const summaryOnly = flags.has('summary-only'); // rebuild CSV + summary log from the cache, no scraping
  const base = flags.has('quick') ? QUICK_OPTIONS : DEFAULT_OPTIONS;
  const opts: RunOptions = {
    maxPages: values.get('max-pages') ?? base.maxPages,
    browserPages: values.get('browser-pages') ?? base.browserPages,
    maxDepth: values.get('max-depth') ?? base.maxDepth,
    budgetMs: (values.get('budget') ?? base.budgetMs / 60_000) * 60_000,
    concurrency: Math.max(1, values.get('concurrency') ?? 12),
    pageConcurrency: Math.max(1, values.get('page-concurrency') ?? base.pageConcurrency),
    hostConcurrency: Math.max(1, values.get('host-concurrency') ?? 3),
  };
  setHostConcurrency(opts.hostConcurrency);
  log.info({ argv: process.argv.slice(2), options: opts, node: process.version, logDir: path.relative(ROOT, LOG_DIR) }, `Run ${runId} started (pid ${process.pid})`);
  if (!summaryOnly) log.info(`Crawl options: ${describe(opts)}`);
  const files = fileArgs.map((f) => path.resolve(f));
  if (!files.length && !fs.existsSync(IN_DIR)) throw new Error(`No input files given and ${path.relative(ROOT, IN_DIR)}/ does not exist`);
  const targets = files.length
    ? files
    : fs.readdirSync(IN_DIR).filter((f) => f.toLowerCase().endsWith('.csv')).sort().map((f) => path.join(IN_DIR, f));
  const byBase = new Map<string, string>();
  for (const f of targets) {
    const b = path.basename(f, path.extname(f));
    if (byBase.has(b)) throw new Error(`${byBase.get(b)} and ${f} would both write emails/${b}.csv; rename one`);
    byBase.set(b, f);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of targets) {
    if (!fs.existsSync(f)) { log.error({ input: f }, `Not found: ${f}`); continue; }
    const base = path.basename(f, path.extname(f));
    const out = path.join(OUT_DIR, base + '.csv');
    const interrupted = fs.existsSync(cacheFiles(CACHE_DIR, base).marker);
    if (!files.length && !force && !retryFailed && !summaryOnly && fs.existsSync(out) && !interrupted) {
      log.info({ input: path.relative(ROOT, f) }, `Skipping ${path.basename(f)} (output exists; use --force)`);
      continue;
    }
    try {
      await withLogContext({ file: base }, () => processFile(f, opts, retryFailed, summaryOnly));
    } catch (err) {
      if (!(err instanceof LockedError)) throw err;
      log.error({ input: path.relative(ROOT, f), err }, `Skipping ${path.basename(f)}: ${err.message}`);
    }
  }
  await closeBrowser();
  log.info({ durationMs: Date.now() - startedAt }, `Run ${runId} finished in ${fmtDuration(Date.now() - startedAt)}`);
}

installProcessHandlers(closeBrowser);
main().then(
  () => process.exit(0),
  (err) => {
    log.fatal({ err }, 'run failed');
    process.exit(1);
  },
);
