import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import pLimit from 'p-limit';
import { closeBrowser, scrapeSite, type SiteResult } from './crawler.js';
import { baseHost, normalizeInput } from './urls.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const IN_DIR = path.join(ROOT, 'websites');
const OUT_DIR = path.join(ROOT, 'emails');
const CACHE_DIR = path.join(OUT_DIR, '.cache');
const LOG_DIR = path.join(OUT_DIR, 'logs');
const SITE_CONCURRENCY = 12;
const SITE_TIMEOUT_MS = 14 * 60_000; // hard safety net; scrapeSite stops itself after 10 min and keeps partial results

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
    const k = baseHost(new URL(u).hostname);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback()), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback()); });
  });
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Human-readable summary of one processed CSV; printed and appended to emails/logs/<name>.log. */
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
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${base}.log`), text + '\n');
  console.log('\n' + text);
}

async function processFile(file: string, retryFailed: boolean, summaryOnly = false): Promise<void> {
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
    for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SiteResult;
        if (retryFailed && r.error) continue; // re-scrape failed sites only
        done.set(r.site, r);
      } catch { /* ignore */ }
    }
  }
  if (retryFailed) fs.writeFileSync(cacheFile, [...done.values()].map((r) => JSON.stringify(r) + '\n').join(''));
  console.log(`\n=== ${base}: ${sites.length} sites (${done.size} cached) ===`);

  let n = done.size;
  const limit = pLimit(SITE_CONCURRENCY);
  await Promise.all(
    sites.map((site) =>
      limit(async () => {
        if (done.has(site) || summaryOnly) return;
        const t0 = Date.now();
        const r = await withTimeout(scrapeSite(site), SITE_TIMEOUT_MS, () => ({
          site, finalUrl: site, business: baseHost(new URL(site).hostname), emails: [], pages: 0, usedBrowser: false, error: 'timeout',
        } as SiteResult));
        done.set(site, r);
        fs.appendFileSync(cacheFile, JSON.stringify(r) + '\n');
        n++;
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(
          `[${n}/${sites.length}] ${baseHost(new URL(site).hostname)} — ${r.emails.length} emails, ${r.pages} pages${r.usedBrowser ? ', browser' : ''}${r.error ? `, ${r.error}` : ''} (${secs}s)`,
        );
      }),
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
  console.log(`=> ${path.relative(ROOT, outFile)}: ${rows.length} emails from ${withEmails}/${sites.length} sites (${failed} failed/unreachable)`);
  const mode = summaryOnly ? 'summary rebuilt from cache' : retryFailed ? 'retry-failed' : 'scrape';
  writeSummary(base, sites, done, rows.length, mode, startedAt);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const retryFailed = args.includes('--retry-failed');
  const summaryOnly = args.includes('--summary-only'); // rebuild CSV + summary log from the cache, no scraping
  const files = args.filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));
  const targets = files.length
    ? files
    : fs.readdirSync(IN_DIR).filter((f) => f.toLowerCase().endsWith('.csv')).sort().map((f) => path.join(IN_DIR, f));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of targets) {
    if (!fs.existsSync(f)) { console.error(`Not found: ${f}`); continue; }
    const out = path.join(OUT_DIR, path.basename(f, path.extname(f)) + '.csv');
    if (!files.length && !force && !retryFailed && !summaryOnly && fs.existsSync(out)) {
      console.log(`Skipping ${path.basename(f)} (output exists; use --force)`);
      continue;
    }
    await processFile(f, retryFailed, summaryOnly);
  }
  await closeBrowser();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
