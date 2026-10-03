import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import pLimit from 'p-limit';
import { closeBrowser, DEFAULT_OPTIONS, QUICK_OPTIONS, scrapeSite, setHostConcurrency, type CrawlOptions, type SiteResult } from './crawler.js';
import { initFileLogging, installProcessHandlers, log, LOG_DIR, parseLevel, runId, withLogContext } from './logger.js';
import { baseHost, normalizeInput } from './urls.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const IN_DIR = path.join(ROOT, 'websites');
const OUT_DIR = path.join(ROOT, 'emails');
const CACHE_DIR = path.join(OUT_DIR, '.cache');
const SUMMARY_DIR = path.join(OUT_DIR, 'logs'); // per-file run summaries; diagnostics go to <root>/logs
const HARD_TIMEOUT_EXTRA_MS = 4 * 60_000; // hard safety net on top of scrapeSite's soft budget, which keeps partial results

interface RunOptions extends CrawlOptions {
  concurrency: number; // sites in parallel
  hostConcurrency: number; // parallel requests to one server across all sites
}

function readSites(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows: string[][] = parse(text, { skip_empty_lines: true, relax_column_count: true, trim: true });
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase());
  let col = header.findIndex((h) => ['website', 'url', 'domain', 'site', 'websites', 'link'].includes(h));
  let body = rows;
  if (col >= 0) body = rows.slice(1);
  else col = 0;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of body) {
    const u = normalizeInput(r[col] ?? '');
    if (!u) continue;
    // Host + path, so several dealer pages on one group domain stay separate sites.
    const url = new URL(u);
    const k = baseHost(url.hostname) + url.pathname.replace(/\/+$/, '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/** Resolves with fallback(reason) on timeout or rejection, so one broken site never stops the run. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: (reason: 'timeout' | 'internal-error') => T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      log.warn({ timeoutMs: ms }, 'site hit the hard timeout; its partial results are lost');
      resolve(fallback('timeout'));
    }, ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => {
        clearTimeout(t);
        log.error({ err }, 'site scrape crashed');
        resolve(fallback('internal-error'));
      },
    );
  });
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
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
  for (const r of failed) reasons.set(r.error!, (reasons.get(r.error!) ?? 0) + 1);
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
  const lines = [
    `[${stamp}] ${base}.csv  (${mode}, took ${fmtDuration(Date.now() - startedAt)})`,
    `  Websites : ${sites.length} total | ${withEmails.length} with emails | ${noEmails.length} no emails found | ${failed.length} failed`,
    `  Emails   : ${uniqueEmails} unique (${persons} person name, ${departments} department page title, ${uniqueEmails - persons - departments} business name)`,
    `  Crawl    : ${results.reduce((n, r) => n + r.pages, 0)} pages fetched | headless browser used on ${results.filter((r) => r.usedBrowser).length} sites`,
  ];
  if (reasons.size) lines.push(`  Failures : ${[...reasons].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (partial.length) lines.push(`  Partial  : ${partial.length} site(s) hit an error/time limit but kept what was found`);
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
  const cacheFile = path.join(CACHE_DIR, `${base}.jsonl`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const sites = readSites(file);
  const done = new Map<string, SiteResult>();
  // The cache is kept after a run for future analysis. It is only used to resume an interrupted run
  // (no output CSV yet); a fresh scrape of an already-finished file starts the cache over.
  if (fs.existsSync(outFile) && fs.existsSync(cacheFile) && !retryFailed && !summaryOnly) fs.rmSync(cacheFile);
  if (fs.existsSync(cacheFile)) {
    for (const [i, line] of fs.readFileSync(cacheFile, 'utf8').split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SiteResult;
        if (retryFailed && r.error) continue; // re-scrape failed sites only
        done.set(r.site, r);
      } catch (err) {
        log.warn({ err, cacheFile: path.relative(ROOT, cacheFile), line: i + 1 }, 'skipping corrupt cache line (site will be re-scraped)');
      }
    }
  }
  if (retryFailed) fs.writeFileSync(cacheFile, [...done.values()].map((r) => JSON.stringify(r) + '\n').join(''));
  log.info({ input: path.relative(ROOT, file), sites: sites.length, cached: done.size }, `\n=== ${base}: ${sites.length} sites (${done.size} cached) ===`);

  let n = done.size;
  const limit = pLimit(opts.concurrency);
  await Promise.all(
    sites.map((site) =>
      limit(() => withLogContext({ site }, async () => {
        if (done.has(site) || summaryOnly) return;
        const t0 = Date.now();
        log.debug('site started');
        const r = await withTimeout(scrapeSite(site, opts), opts.budgetMs + HARD_TIMEOUT_EXTRA_MS, (error) => ({
          site, finalUrl: site, business: baseHost(new URL(site).hostname), emails: [], pages: 0, usedBrowser: false, error,
        } as SiteResult));
        done.set(site, r);
        fs.appendFileSync(cacheFile, JSON.stringify(r) + '\n');
        n++;
        const ms = Date.now() - t0;
        const fields = { finalUrl: r.finalUrl, emails: r.emails.length, pages: r.pages, usedBrowser: r.usedBrowser, error: r.error, durationMs: ms };
        const msg = `[${n}/${sites.length}] ${baseHost(new URL(site).hostname)} — ${r.emails.length} emails, ${r.pages} pages${r.usedBrowser ? ', browser' : ''}${r.error ? `, ${r.error}` : ''} (${(ms / 1000).toFixed(0)}s)`;
        if (r.error && !r.emails.length) log.warn(fields, msg);
        else log.info(fields, msg);
      })),
    ),
  );

  // build CSV in input order, unique by email
  const rows: [string, string, string, string][] = [];
  const seenEmail = new Set<string>();
  let failed = 0;
  for (const site of sites) {
    const r = done.get(site);
    if (!r) continue;
    if (r.error && !r.emails.length) failed++;
    for (const e of r.emails) {
      if (seenEmail.has(e.email)) continue;
      seenEmail.add(e.email);
      rows.push([e.name || e.pageTitle || r.business, e.email, r.site, e.link ?? '']);
    }
  }
  fs.writeFileSync(outFile, stringify(rows, { header: true, columns: ['name', 'email', 'website', 'link'] }));
  const withEmails = sites.filter((s) => (done.get(s)?.emails.length ?? 0) > 0).length;
  log.info({ output: path.relative(ROOT, outFile), emails: rows.length, withEmails, failed }, `=> ${path.relative(ROOT, outFile)}: ${rows.length} emails from ${withEmails}/${sites.length} sites (${failed} failed/unreachable)`);
  const mode = summaryOnly ? 'summary rebuilt from cache' : `${retryFailed ? 'retry-failed' : 'scrape'}: ${describe(opts)}`;
  writeSummary(base, sites, done, rows.length, mode, startedAt);
}

const NUMERIC_FLAGS = ['max-pages', 'browser-pages', 'max-depth', 'budget', 'concurrency', 'page-concurrency', 'host-concurrency'];
const STRING_FLAGS = ['log-level'];

/** Splits argv into flags and file paths. Value flags accept `--x=V` and `--x V`. */
function parseArgs(argv: string[]): { flags: Set<string>; values: Map<string, number>; strings: Map<string, string>; files: string[] } {
  const flags = new Set<string>();
  const values = new Map<string, number>();
  const strings = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    const [name, inline] = a.slice(2).split('=', 2);
    if (STRING_FLAGS.includes(name)) {
      const raw = inline ?? argv[++i];
      if (!raw) throw new Error(`--${name} needs a value`);
      strings.set(name, raw);
      continue;
    }
    if (!NUMERIC_FLAGS.includes(name)) { flags.add(name); continue; }
    const raw = inline ?? argv[++i];
    const n = Number(raw);
    if (raw === undefined || !Number.isFinite(n) || n < 0) throw new Error(`--${name} needs a number, got "${raw ?? ''}"`);
    values.set(name, n);
  }
  return { flags, values, strings, files };
}

async function main() {
  const startedAt = Date.now();
  const { flags, values, strings, files: fileArgs } = parseArgs(process.argv.slice(2));
  initFileLogging(parseLevel(strings.get('log-level')) ?? parseLevel(process.env.LOG_LEVEL) ?? 'info');
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
  const unknown = [...flags].filter((f) => !['force', 'retry-failed', 'summary-only', 'quick'].includes(f));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.map((f) => '--' + f).join(', ')}`);
  setHostConcurrency(opts.hostConcurrency);
  log.info({ argv: process.argv.slice(2), options: opts, node: process.version, logDir: path.relative(ROOT, LOG_DIR) }, `Run ${runId} started (pid ${process.pid})`);
  if (!summaryOnly) log.info(`Crawl options: ${describe(opts)}`);
  const files = fileArgs.map((f) => path.resolve(f));
  const targets = files.length
    ? files
    : fs.readdirSync(IN_DIR).filter((f) => f.toLowerCase().endsWith('.csv')).sort().map((f) => path.join(IN_DIR, f));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of targets) {
    if (!fs.existsSync(f)) { log.error({ input: f }, `Not found: ${f}`); continue; }
    const out = path.join(OUT_DIR, path.basename(f, path.extname(f)) + '.csv');
    if (!files.length && !force && !retryFailed && !summaryOnly && fs.existsSync(out)) {
      log.info({ input: path.relative(ROOT, f) }, `Skipping ${path.basename(f)} (output exists; use --force)`);
      continue;
    }
    const base = path.basename(f, path.extname(f));
    await withLogContext({ file: base }, () => processFile(f, opts, retryFailed, summaryOnly));
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
