import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, beginScrape, budgetRetry, cacheFiles, endScrape, ensureTrailingNewline, failedRetry, loadCache, LockedError, planRetries, rateLimitedRetry, writeCacheAtomic } from '../src/cache.js';
import { parseArgs, rawFlag, retryOptions } from '../src/cli.js';
import type { SiteResult } from '../src/crawler.js';
import { readSites } from '../src/input.js';
import { buildRows, safeCell, uniqueLabel, uniqueRows } from '../src/output.js';
import { categoryOf, fileLayout, findInputs, findOutputs, groupOf } from '../src/paths.js';

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

test('--retry-budget-queued takes minutes as --x=N, --x N, or none; a file after it stays a file', () => {
  const alone = parseArgs(['--retry-budget-queued', 'websites/a.csv']);
  assert.ok(alone.flags.has('retry-budget-queued'));
  assert.equal(alone.values.get('retry-budget-queued'), undefined);
  assert.deepEqual(alone.files, ['websites/a.csv']);
  assert.equal(parseArgs(['--retry-budget-queued=60']).values.get('retry-budget-queued'), 60);
  const spaced = parseArgs(['--retry-budget-queued', '7.5', 'a.csv']);
  assert.equal(spaced.values.get('retry-budget-queued'), 7.5);
  assert.deepEqual(spaced.files, ['a.csv']);
  assert.throws(() => parseArgs(['--retry-budget-queued=0']), /minutes > 0/);
  assert.throws(() => parseArgs(['--retry-budget-queued=abc']), /minutes > 0/);
  assert.ok(parseArgs(['--retry-rate-limited']).flags.has('retry-rate-limited'));
  assert.throws(() => parseArgs(['--retry-rate-limited=1']), /takes no value/);
});

test('retryOptions: the three retries are independent, and the budget is given once', () => {
  assert.deepEqual(retryOptions(parseArgs(['--retry-failed', '--retry-rate-limited'])), { failed: true, rateLimited: true, budget: false, budgetMin: undefined });
  assert.deepEqual(retryOptions(parseArgs(['--retry-budget-queued=45'])), { failed: false, rateLimited: false, budget: true, budgetMin: 45 });
  assert.equal(retryOptions(parseArgs(['--retry-budget-queued', '--budget=30'])).budgetMin, undefined);
  assert.throws(() => retryOptions(parseArgs(['--retry-budget-queued=60', '--budget=30'])), /give it once/);
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

test('loadCache recovers records glued onto one line by an interrupted run', () => {
  const files = cacheFiles(tmp(), 'x');
  const a = JSON.stringify(site('https://a.nz/', { business: 'Shop } {"x"' }));
  const b = JSON.stringify(site('https://b.nz/'));
  const c = JSON.stringify(site('https://c.nz/'));
  fs.writeFileSync(files.cache, `${a}${b}\n${c}\0\0\0${a.replace('a.nz', 'd.nz')}\n{"site":"htt${b.replace('b.nz', 'e.nz')}\n`);
  assert.deepEqual([...loadCache(files.cache).keys()].sort(), ['https://a.nz/', 'https://b.nz/', 'https://c.nz/', 'https://d.nz/', 'https://e.nz/']);
});

test('ensureTrailingNewline keeps the next append on its own line', () => {
  const files = cacheFiles(tmp(), 'x');
  ensureTrailingNewline(files.cache); // missing file: no-op
  assert.ok(!fs.existsSync(files.cache));
  fs.writeFileSync(files.cache, '');
  ensureTrailingNewline(files.cache);
  assert.equal(fs.readFileSync(files.cache, 'utf8'), '');
  const a = JSON.stringify(site('https://a.nz/'));
  fs.writeFileSync(files.cache, a); // cut off before its newline
  ensureTrailingNewline(files.cache);
  ensureTrailingNewline(files.cache); // already ends in \n: no-op
  fs.appendFileSync(files.cache, JSON.stringify(site('https://b.nz/')) + '\n');
  const lines = fs.readFileSync(files.cache, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
});

test('retry predicates: failures, rate-limited pages and time-budget queues; never robots blocks (M10)', () => {
  const emails = [{ email: 'a@b.nz', name: null, link: 'x' }];
  const resume = (extra = {}) => ({ queued: [], limited: [], attempts: 5, ...extra });
  assert.equal(failedRetry(site('a', { error: 'unreachable' })), true);
  assert.equal(failedRetry(site('a', { error: 'robots-disallowed' })), false);
  assert.equal(failedRetry(site('a', { error: 'timeout', emails })), false);
  assert.equal(failedRetry(site('a', { emails, rateLimited: 3 })), false); // rate limiting is its own retry now
  assert.equal(rateLimitedRetry(site('a', { emails, rateLimited: 3 })), true); // pre-v3 row: only a count
  assert.equal(rateLimitedRetry(site('a', { v: 3, emails, rateLimited: 1 })), false); // v3, but no page of its own was skipped
  assert.equal(rateLimitedRetry(site('a', { v: 3, emails, rateLimited: 1, resume: resume({ limited: [['https://a/x', 2]] }) })), true);
  assert.equal(rateLimitedRetry(site('a', { error: 'robots-disallowed', rateLimited: 1 })), false);
  assert.equal(budgetRetry(site('a', { emails, budgetQueued: 40 })), true); // marked from the logs
  assert.equal(budgetRetry(site('a', { v: 3, resume: resume({ browser: 'no-emails' }) })), true);
  assert.equal(budgetRetry(site('a', { v: 3, emails })), false);
  assert.equal(budgetRetry(site('a', { error: 'robots-disallowed', budgetQueued: 3 })), false);
});

test('planRetries: saved state is continued, rows without it are crawled again keeping the better result', () => {
  const emails = [{ email: 'a@b.nz', name: null, link: 'x' }];
  const st = { queued: [['https://n.nz/q', 2]] as [string, number][], limited: [['https://n.nz/l', 2]] as [string, number][], attempts: 9 };
  const done = new Map<string, SiteResult>([
    ['f', site('f', { error: 'unreachable' })],
    ['old', site('old', { emails, budgetQueued: 50, rateLimited: 2 })],
    ['new', site('new', { v: 3, emails, budgetQueued: 50, rateLimited: 1, resume: st })],
    ['ok', site('ok', { v: 3, emails })],
    ['rb', site('rb', { error: 'robots-disallowed', budgetQueued: 1 })],
  ]);
  const all = planRetries(done, { failed: true, rateLimited: true, budget: true });
  assert.deepEqual([...all.recrawl].sort(), ['f', 'old']);
  assert.deepEqual([...all.previous.keys()], ['old']);
  assert.deepEqual(Object.fromEntries(all.resume), { new: { budget: true, limited: true } });

  const budgetOnly = planRetries(done, { failed: false, rateLimited: false, budget: true });
  assert.deepEqual([...budgetOnly.recrawl], ['old']);
  assert.deepEqual(Object.fromEntries(budgetOnly.resume), { new: { budget: true, limited: false } });

  const limitedOnly = planRetries(done, { failed: false, rateLimited: true, budget: false });
  assert.deepEqual(Object.fromEntries(limitedOnly.resume), { new: { budget: false, limited: true } });
  // a v3 row with only rate-limited pages left is not picked by the budget retry
  assert.equal(planRetries(new Map([['x', site('x', { v: 3, emails, resume: { ...st, queued: [] } })]]), { failed: false, rateLimited: false, budget: true }).resume.size, 0);
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

// ---------- --unique ----------

test('parseArgs accepts --unique', () => {
  assert.ok(parseArgs(['--unique', 'websites/au.a.csv']).flags.has('unique'));
  assert.throws(() => parseArgs(['--unique=1']), /takes no value/);
});

test('uniqueRows keeps each email once across files, first file wins, case-insensitive', () => {
  const { rows, read, overlaps } = uniqueRows([
    { base: 'au.a', rows: [['A', 'x@a.com', 'https://a.com/', ''], ['B', 'y@a.com', 'https://a.com/', '']] },
    { base: 'au.b', rows: [['Other', 'X@A.com ', 'https://b.com/', ''], ['C', 'z@b.com', 'https://b.com/', '']] },
    { base: 'au.c', rows: [['D', 'y@a.com', 'https://c.com/', ''], ['E', 'z@b.com', 'https://c.com/', '']] },
  ]);
  assert.equal(read, 6);
  assert.deepEqual(rows.map((r) => [r[0], r[1]]), [['A', 'x@a.com'], ['B', 'y@a.com'], ['C', 'z@b.com']]);
  assert.deepEqual(Object.fromEntries(overlaps), { 'au.b ← au.a': 1, 'au.c ← au.a': 1, 'au.c ← au.b': 1 });
});

test('uniqueLabel names the combined file after the shared prefix', () => {
  assert.equal(uniqueLabel(['au.ford', 'au.kia']), 'au');
  assert.equal(uniqueLabel(['nz_dentists_all', 'nz_hospitals_all']), 'nz');
  assert.equal(uniqueLabel(['au.ford', 'nz_dentists_all']), 'all');
  assert.equal(uniqueLabel(['clinics']), 'clinics');
});

// ---------- category folders ----------

const IN = path.join(path.sep, 'p', 'websites');
const OUT = path.join(path.sep, 'p', 'emails');

test('groupOf: category folder, else the file name; outputs map back to the same group', () => {
  assert.equal(groupOf(path.join(IN, 'dealers', 'au.ford.csv'), IN, OUT), 'dealers');
  assert.equal(groupOf(path.join(IN, 'clinics.csv'), IN, OUT), 'clinics');
  assert.equal(groupOf(path.join(path.sep, 'elsewhere', 'sample.csv'), IN, OUT), 'sample');
  assert.equal(groupOf(path.join(OUT, 'dealers', 'emails', 'au.ford.csv'), IN, OUT), 'dealers');
  assert.equal(groupOf(path.join(IN, 'a', 'b', 'x.csv'), IN, OUT), 'x'); // only one level of category
  assert.equal(categoryOf(path.join(IN, 'clinics.csv'), IN, OUT), undefined);
});

test('fileLayout puts output, cache, logs and unique inside the group folder', () => {
  const l = fileLayout('dealers', 'au.ford', OUT);
  assert.equal(l.id, 'dealers/au.ford');
  assert.equal(l.outFile, path.join(OUT, 'dealers', 'emails', 'au.ford.csv'));
  assert.equal(l.cacheDir, path.join(OUT, 'dealers', '.cache'));
  assert.equal(l.logDir, path.join(OUT, 'dealers', 'logs'));
  assert.equal(l.uniqueDir, path.join(OUT, 'dealers', 'unique'));
});

test('findInputs and findOutputs walk one level of category folders', () => {
  const d = tmp();
  const put = (...p: string[]) => { fs.mkdirSync(path.dirname(path.join(d, ...p)), { recursive: true }); fs.writeFileSync(path.join(d, ...p), 'x'); };
  put('top.csv'); put('dealers', 'a.csv'); put('dealers', 'notes.txt'); put('dealers', 'deep', 'z.csv'); put('.hidden', 'h.csv');
  assert.deepEqual(findInputs(d).map((f) => path.relative(d, f)), [path.join('dealers', 'a.csv'), 'top.csv']);
  put('dealers', 'emails', 'a.csv'); put('dealers', 'top-level-ignored.csv'); put('unique', 'u.csv'); put('logs', 'l.csv'); put('.cache', 'c.csv');
  assert.deepEqual([...findOutputs(d)].map(([g, f]) => [g, f.map((x) => path.basename(x))]), [['dealers', ['a.csv']]]);
});
