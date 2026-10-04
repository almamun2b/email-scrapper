import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, beginScrape, cacheFiles, endScrape, isRetryable, loadCache, LockedError, writeCacheAtomic } from '../src/cache.js';
import { parseArgs, rawFlag } from '../src/cli.js';
import type { SiteResult } from '../src/crawler.js';
import { readSites } from '../src/input.js';
import { buildRows, safeCell } from '../src/output.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-test-'));
const site = (s: string, extra: Partial<SiteResult> = {}): SiteResult => ({
  site: s, finalUrl: s, business: 'Biz', emails: [], pages: 1, usedBrowser: false, ...extra,
});

// ---------- CLI (L1) ----------

test('parseArgs accepts valid flags in both forms', () => {
  const a = parseArgs(['--force', '--max-pages=10', '--budget', '2.5', '--log-level=debug', 'x.csv']);
  assert.ok(a.flags.has('force'));
  assert.equal(a.values.get('max-pages'), 10);
  assert.equal(a.values.get('budget'), 2.5);
  assert.equal(a.strings.get('log-level'), 'debug');
  assert.deepEqual(a.files, ['x.csv']);
});

test('parseArgs rejects values on boolean flags, fractions on counts, unknown flags (L1)', () => {
  assert.throws(() => parseArgs(['--force=false']), /takes no value/);
  assert.throws(() => parseArgs(['--quick=0']), /takes no value/);
  assert.throws(() => parseArgs(['--page-concurrency=2.5']), /whole number/);
  assert.throws(() => parseArgs(['--host-concurrency', '1.5']), /whole number/);
  assert.throws(() => parseArgs(['--max-pages']), /whole number/);
  assert.throws(() => parseArgs(['--budget=-1']), /number/);
  assert.throws(() => parseArgs(['--frobnicate']), /Unknown option/);
});

test('rawFlag reads a flag before validation', () => {
  assert.equal(rawFlag(['--log-level', 'warn', '--bogus'], 'log-level'), 'warn');
  assert.equal(rawFlag(['--log-level=error'], 'log-level'), 'error');
  assert.equal(rawFlag(['--force'], 'log-level'), undefined);
});

// ---------- input (M12, L14) ----------

function csv(text: string): string {
  const f = path.join(tmp(), 'in.csv');
  fs.writeFileSync(f, text);
  return f;
}

test('readSites: exact header', () => {
  const r = readSites(csv('name,website\nA,a.co.nz\nB,https://b.co.nz/\n'));
  assert.deepEqual(r.sites, ['https://a.co.nz/', 'https://b.co.nz/']);
});

test('readSites: fuzzy header such as "Company Website" (M12)', () => {
  const r = readSites(csv('Company Name,Company Website\nAcme Ltd,acme.co.nz\nBeta Ltd,beta.co.nz\n'));
  assert.deepEqual(r.sites, ['https://acme.co.nz/', 'https://beta.co.nz/']);
});

test('readSites: unrecognised header picks the URL-like column and skips the header row (M12)', () => {
  const r = readSites(csv('Business,Web\nAcme Ltd,acme.co.nz\nBeta Ltd,beta.co.nz\n'));
  assert.deepEqual(r.sites, ['https://acme.co.nz/', 'https://beta.co.nz/']);
  const r2 = readSites(csv('Business,Homepage\nAcme Ltd,acme.co.nz\nBeta Ltd,beta.co.nz\n'));
  assert.deepEqual(r2.sites, ['https://acme.co.nz/', 'https://beta.co.nz/']);
  assert.equal(r2.header, true);
});

test('readSites: headerless file keeps the first row', () => {
  assert.deepEqual(readSites(csv('a.co.nz\nb.co.nz\n')).sites, ['https://a.co.nz/', 'https://b.co.nz/']);
});

test('readSites: counts invalid and duplicate rows; query strings stay distinct (L14)', () => {
  const r = readSites(csv('website\na.co.nz\nwww.a.co.nz/\nnot a url\ng.nz/d?id=1\ng.nz/d?id=2\n'));
  assert.deepEqual(r.sites, ['https://a.co.nz/', 'https://g.nz/d?id=1', 'https://g.nz/d?id=2']);
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
});

// ---------- cache (H3, M10, M11) ----------

test('beginScrape rotates a finished run\'s cache instead of deleting it (H3)', () => {
  const files = cacheFiles(tmp(), 'x');
  fs.writeFileSync(files.cache, JSON.stringify(site('https://a.nz/')) + '\n');
  const r = beginScrape(files, true);
  assert.equal(r.resumed, false);
  assert.ok(r.rotatedTo && fs.existsSync(r.rotatedTo));
  assert.ok(!fs.existsSync(files.cache));
  assert.ok(fs.existsSync(files.marker));
});

test('--retry-failed reuses a finished run\'s cache instead of rotating it', () => {
  const dir = tmp();
  const files = cacheFiles(dir, 'x');
  const line = JSON.stringify(site('https://a.nz/')) + '\n';
  fs.writeFileSync(files.cache, line);
  const r = beginScrape(files, true, true);
  assert.deepEqual(r, { resumed: false, rotatedTo: undefined });
  assert.equal(fs.readFileSync(files.cache, 'utf8'), line);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['x.inprogress', 'x.jsonl']);
});

test('an interrupted re-scrape resumes instead of resetting again (H3)', () => {
  const files = cacheFiles(tmp(), 'x');
  fs.writeFileSync(files.cache, 'old\n');
  beginScrape(files, true); // run 1 starts, rotates the old cache
  fs.writeFileSync(files.cache, JSON.stringify(site('https://a.nz/')) + '\n'); // run 1 finishes one site, then dies
  const r = beginScrape(files, true); // run 2: output still exists, but the marker says "interrupted"
  assert.equal(r.resumed, true);
  assert.equal(loadCache(files.cache).size, 1);
  endScrape(files);
  assert.ok(!fs.existsSync(files.marker));
});

test('without an output, an existing cache is resumed (legacy interrupted run)', () => {
  const files = cacheFiles(tmp(), 'x');
  fs.writeFileSync(files.cache, JSON.stringify(site('https://a.nz/')) + '\n');
  assert.equal(beginScrape(files, false).rotatedTo, undefined);
  assert.equal(loadCache(files.cache).size, 1);
});

test('loadCache skips corrupt lines', () => {
  const files = cacheFiles(tmp(), 'x');
  fs.writeFileSync(files.cache, JSON.stringify(site('https://a.nz/')) + '\n{"site":"htt\n');
  assert.equal(loadCache(files.cache).size, 1);
});

test('isRetryable: failures with no emails and rate-limited sites, never robots blocks (M10)', () => {
  const emails = [{ email: 'a@b.nz', name: null, link: 'x' }];
  assert.equal(isRetryable(site('a', { error: 'unreachable' })), true);
  assert.equal(isRetryable(site('a', { error: 'robots-disallowed' })), false);
  assert.equal(isRetryable(site('a', { error: 'timeout', emails })), false);
  assert.equal(isRetryable(site('a')), false);
  assert.equal(isRetryable(site('a', { emails, rateLimited: 3 })), true);
  assert.equal(isRetryable(site('a', { emails })), false);
  assert.equal(isRetryable(site('a', { error: 'robots-disallowed', rateLimited: 1 })), false);
});

test('writeCacheAtomic leaves no temp file', () => {
  const dir = tmp();
  const files = cacheFiles(dir, 'x');
  writeCacheAtomic(files.cache, [site('https://a.nz/')]);
  assert.deepEqual(fs.readdirSync(dir), ['x.jsonl']);
});

test('acquireLock refuses a live holder and takes over a stale one (M11)', () => {
  const files = cacheFiles(tmp(), 'x');
  fs.writeFileSync(files.lock, String(process.ppid)); // a live process that isn't us
  assert.throws(() => acquireLock(files.lock), LockedError);
  fs.writeFileSync(files.lock, '999999999'); // no such pid
  const release = acquireLock(files.lock);
  assert.equal(fs.readFileSync(files.lock, 'utf8'), String(process.pid));
  release();
  assert.ok(!fs.existsSync(files.lock));
});

// ---------- output (M7) ----------

test('safeCell neutralises formulas (M7)', () => {
  assert.equal(safeCell('=HYPERLINK("http://evil","x")'), `'=HYPERLINK("http://evil","x")`);
  assert.equal(safeCell('+64 9 123'), "'+64 9 123");
  assert.equal(safeCell('@home'), "'@home");
  assert.equal(safeCell('Acme Dental'), 'Acme Dental');
});

test('buildRows: input order, unique by email, name fallback, formula-safe', () => {
  const done = new Map<string, SiteResult>([
    ['https://a.nz/', site('https://a.nz/', { business: '=evil()', emails: [{ email: 'x@a.nz', name: null, link: 'l1' }] })],
    ['https://b.nz/', site('https://b.nz/', { emails: [{ email: 'x@a.nz', name: 'Jo Bloggs', link: 'l2' }, { email: 'y@b.nz', name: null, link: 'l3', pageTitle: 'Cardiology' }] })],
  ]);
  assert.deepEqual(buildRows(['https://a.nz/', 'https://b.nz/', 'https://c.nz/'], done), [
    ["'=evil()", 'x@a.nz', 'https://a.nz/', 'l1'],
    ['Cardiology', 'y@b.nz', 'https://b.nz/', 'l3'],
  ]);
});
