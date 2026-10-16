import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, beginScrape, budgetRetry, cacheFiles, cappedRetry, endScrape, ensureTrailingNewline, failedRetry, loadCache, LockedError, planRetries, rateLimitedRetry, writeCacheAtomic, writeFileAtomic } from '../src/cache.js';
import { BOOLEAN_FLAGS, DEFAULT_REVALIDATE_DAYS, INTEGER_FLAGS, NUMBER_FLAGS, OPTIONAL_NUMBER_FLAGS, parseArgs, rawFlag, retryOptions, STRING_FLAGS, USAGE } from '../src/cli.js';
import { setMxResolver, undeliverable } from '../src/mx.js';
import type { SiteResult } from '../src/crawler.js';
import { readSites } from '../src/input.js';
import { assignRows, recheckSite, safeCell, uniqueLabel, uniqueRows } from '../src/output.js';
import { categoryOf, fileLayout, findInputs, findOutputs, groupOf } from '../src/paths.js';
import { closePages, previewFile, processFile, staleState, writeUnique } from '../src/run.js';
import { DEFAULT_OPTIONS } from '../src/crawler.js';
import { page, startServer } from './helpers/server.js';

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

test('parseArgs accepts --new-only and it takes no value', () => {
  assert.ok(parseArgs(['--new-only', 'x.csv']).flags.has('new-only'));
  assert.throws(() => parseArgs(['--new-only=1']), /takes no value/);
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
  assert.deepEqual(retryOptions(parseArgs(['--retry-failed', '--retry-rate-limited'])), { failed: true, rateLimited: true, budget: false, capped: false, budgetMin: undefined });
  assert.deepEqual(retryOptions(parseArgs(['--retry-budget-queued=45'])), { failed: false, rateLimited: false, budget: true, capped: false, budgetMin: 45 });
  assert.equal(retryOptions(parseArgs(['--retry-budget-queued', '--budget=30'])).budgetMin, undefined);
  assert.throws(() => retryOptions(parseArgs(['--retry-budget-queued=60', '--budget=30'])), /give it once/);
});

test('--revalidate takes days as --x=N, --x N, or none; a file after it stays a file', () => {
  const alone = parseArgs(['--revalidate', 'websites/a.csv']);
  assert.ok(alone.flags.has('revalidate'));
  assert.equal(alone.values.get('revalidate'), undefined);
  assert.deepEqual(alone.files, ['websites/a.csv']);
  assert.equal(parseArgs(['--revalidate=7']).values.get('revalidate'), 7);
  assert.equal(parseArgs(['--revalidate=0']).values.get('revalidate'), 0);
  assert.equal(parseArgs(['--revalidate', '0.5', 'a.csv']).values.get('revalidate'), 0.5);
  assert.ok(!parseArgs(['a.csv']).flags.has('revalidate'));
  assert.throws(() => parseArgs(['--revalidate=-1']), /days ≥ 0/);
  assert.throws(() => parseArgs(['--revalidate=abc']), /days ≥ 0/);
  assert.equal(DEFAULT_REVALIDATE_DAYS, 30);
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

test("readSites: the input's name column is read per site", () => {
  const r = readSites(csv('website,name\na.co.nz,  Acme   Dental \nb.co.nz,\n'));
  assert.deepEqual([...r.names], [['https://a.co.nz/', 'Acme Dental']]);
  assert.deepEqual([...readSites(csv('Business Name,Website\nAcme,a.co.nz\n')).names], [['https://a.co.nz/', 'Acme']]);
  assert.equal(readSites(csv('a.co.nz,Acme\n')).names.size, 0); // no header row, no name column
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

test('--new-only reuses a finished run\'s cache, so only sites missing from it are scraped', () => {
  const dir = tmp();
  const files = cacheFiles(dir, 'x');
  const line = JSON.stringify(site('https://a.nz/')) + '\n';
  fs.writeFileSync(files.cache, line);
  const r = beginScrape(files, true, true);
  assert.equal(r.rotatedTo, undefined);
  assert.equal(fs.readFileSync(files.cache, 'utf8'), line);
  assert.deepEqual([...loadCache(files.cache).keys()], ['https://a.nz/']);
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

test('planRetries: saved state is continued, rows without it are crawled again keeping the old row', () => {
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
  assert.deepEqual(Object.fromEntries(all.resume), { new: { budget: true, limited: true, capped: false } });

  const budgetOnly = planRetries(done, { failed: false, rateLimited: false, budget: true });
  assert.deepEqual([...budgetOnly.recrawl], ['old']);
  assert.deepEqual(Object.fromEntries(budgetOnly.resume), { new: { budget: true, limited: false, capped: false } });

  const limitedOnly = planRetries(done, { failed: false, rateLimited: true, budget: false });
  assert.deepEqual(Object.fromEntries(limitedOnly.resume), { new: { budget: false, limited: true, capped: false } });
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

test('assignRows: input order, unique by email, name fallback, formula-safe', () => {
  const done = new Map<string, SiteResult>([
    ['https://a.nz/', site('https://a.nz/', { business: '=evil()', emails: [{ email: 'x@a.nz', name: null, link: 'l1' }] })],
    ['https://b.nz/', site('https://b.nz/', { emails: [{ email: 'x@a.nz', name: 'Jo Bloggs', link: 'l2' }, { email: 'y@b.nz', name: null, link: 'l3', pageTitle: 'Cardiology' }] })],
  ]);
  const out = assignRows(['https://a.nz/', 'https://b.nz/', 'https://c.nz/'], done);
  assert.deepEqual(out.rows, [
    ["'=evil()", 'x@a.nz', 'https://a.nz/', 'l1'],
    ['Cardiology', 'y@b.nz', 'https://b.nz/', 'l3'],
  ]);
  assert.deepEqual(out.kinds, { person: 0, department: 1, input: 0, business: 1 });
});

test('assignRows credits an email to the site that owns its domain, not the first one listing it (B4)', () => {
  const sites = ['https://www.bydhaberfield.com.au/', 'https://bydcastlehill.com.au/'];
  const done = new Map<string, SiteResult>([
    [sites[0], site(sites[0], { business: 'BYD Haberfield', emails: [
      { email: 'sales@bydcastlehill.com.au', name: null, link: 'h1', source: 'raw' },
      { email: 'sales@bydhaberfield.com.au', name: null, link: 'h2', source: 'mailto' },
    ] })],
    [sites[1], site(sites[1], { business: 'BYD Castle Hill', emails: [{ email: 'sales@bydcastlehill.com.au', name: null, link: 'c1', source: 'mailto' }] })],
  ]);
  assert.deepEqual(assignRows(sites, done).rows, [
    ['BYD Haberfield', 'sales@bydhaberfield.com.au', sites[0], 'h2'],
    ['BYD Castle Hill', 'sales@bydcastlehill.com.au', sites[1], 'c1'],
  ]);
});

test('assignRows prefers a site where the email was not only in raw HTML (B4)', () => {
  const sites = ['https://a.com.au/', 'https://b.com.au/'];
  const done = new Map<string, SiteResult>([
    [sites[0], site(sites[0], { emails: [{ email: 'jo@gmail.com', name: null, link: 'a', source: 'raw' }] })],
    [sites[1], site(sites[1], { emails: [{ email: 'jo@gmail.com', name: null, link: 'b', source: 'mailto' }] })],
  ]);
  assert.equal(assignRows(sites, done).rows[0][2], sites[1]);
});

test('assignRows moves emails on 3+ sites that none of them owns to shared (D1)', () => {
  const dealer = (host: string) => site(`https://${host}/`, { business: host, emails: [
    { email: 'enquiries@oaic.gov.au', name: null, link: `https://${host}/privacy` },
    { email: `sales@${host}`, name: null, link: `https://${host}/` },
  ] });
  const sites = ['https://a.com.au/', 'https://b.com.au/', 'https://c.com.au/'];
  const done = new Map(sites.map((s) => [s, dealer(new URL(s).hostname)]));
  const out = assignRows(sites, done);
  assert.deepEqual(out.rows.map((r) => r[1]), ['sales@a.com.au', 'sales@b.com.au', 'sales@c.com.au']);
  assert.deepEqual(out.shared, [['a.com.au', 'enquiries@oaic.gov.au', 'https://a.com.au/', 'https://a.com.au/privacy']]);
  assert.equal(out.sharedOn.get('enquiries@oaic.gov.au'), 3);
  // on only two sites it stays in the main list
  assert.equal(assignRows(sites.slice(0, 2), done).shared.length, 0);
  // several pages of one domain count as one site
  const pages = ['https://a.com.au/x', 'https://a.com.au/y', 'https://a.com.au/z'];
  assert.equal(assignRows(pages, new Map(pages.map((p) => [p, { ...dealer('a.com.au'), site: p }]))).shared.length, 0);
});

test("assignRows uses the input's own name before the scraped business name, after person and department names", () => {
  const sites = ['https://a.nz/', 'https://b.nz/'];
  const done = new Map<string, SiteResult>([
    [sites[0], site(sites[0], { business: 'Home', emails: [{ email: 'info@a.nz', name: null, link: 'l' }, { email: 'jo@a.nz', name: 'Jo Bloggs', link: 'l' }] })],
    [sites[1], site(sites[1], { business: 'B Ltd', emails: [{ email: 'info@b.nz', name: null, link: 'l', pageTitle: 'Cardiology' }] })],
  ]);
  const out = assignRows(sites, done, new Map([[sites[0], 'St Mary’s Church'], [sites[1], 'B Clinic']]));
  assert.deepEqual(out.rows.map((r) => r[0]), ['St Mary’s Church', 'Jo Bloggs', 'Cardiology']);
  assert.deepEqual(out.kinds, { person: 1, department: 1, input: 1, business: 0 });
});

test('recheckSite tidies cached business names and drops generic department titles (D3)', () => {
  const r = recheckSite(site('https://www.acme.co.nz/', { finalUrl: 'https://www.acme.co.nz/', business: 'Home', emails: [{ email: 'info@acme.co.nz', name: null, link: 'l', pageTitle: 'Contact Us' }] }));
  assert.equal(r.business, 'acme.co.nz');
  assert.equal(r.emails[0].pageTitle, undefined);
  assert.equal(recheckSite(site('https://x.nz/', { business: 'Welcome to The Denture Place' })).business, 'The Denture Place');
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

test('writeUnique adds shared/ rows after every main CSV, so an owner\'s row wins', () => {
  const out = path.join(tmp(), 'emails');
  const a = fileLayout('dealers', 'a', out);
  const b = fileLayout('dealers', 'b', out);
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(a.outFile, 'name,email,website,link\nA,sales@a.com.au,https://a.com.au/,l\n');
  put(a.sharedFile, 'name,email,website,link\nX,help@finance.com.au,https://a.com.au/,l\nY,info@b.com.au,https://a.com.au/,l\n');
  put(b.outFile, 'name,email,website,link\nB,info@b.com.au,https://b.com.au/,l\n');
  const target = path.join(a.uniqueDir, 'dealers.csv');
  writeUnique([{ id: 'a', file: a.outFile, shared: a.sharedFile }, { id: 'b', file: b.outFile, shared: b.sharedFile }], 'dealers', target, a.logDir);
  const rows = parse(fs.readFileSync(target, 'utf8'), { columns: true }) as Record<string, string>[];
  assert.deepEqual(rows.map((r) => [r.name, r.email, r.website]), [
    ['A', 'sales@a.com.au', 'https://a.com.au/'],
    ['B', 'info@b.com.au', 'https://b.com.au/'],
    ['X', 'help@finance.com.au', 'https://a.com.au/'],
  ]);
  const summary = fs.readFileSync(path.join(a.logDir, 'unique.dealers.log'), 'utf8');
  assert.match(summary, /Shared {3}: 2 row\(s\) from shared\/ \(a 2\), 1 added/);
  assert.match(summary, /Rows {5}: 4 read, 1 duplicate\(s\) removed/);

  fs.rmSync(path.dirname(a.sharedFile), { recursive: true });
  writeUnique([{ id: 'a', file: a.outFile, shared: a.sharedFile }, { id: 'b', file: b.outFile, shared: b.sharedFile }], 'dealers', target, a.logDir);
  assert.deepEqual((parse(fs.readFileSync(target, 'utf8'), { columns: true }) as Record<string, string>[]).map((r) => r.email), ['sales@a.com.au', 'info@b.com.au']);
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
  assert.equal(l.pagesFile, path.join(OUT, 'dealers', '.cache', '.pages'), 'one page store per category');
  assert.equal(fileLayout('dealers', 'au.toyota', OUT).pagesFile, l.pagesFile);
  assert.equal(l.pagesLock, path.join(OUT, 'dealers', '.cache', '.pages.lock'));
});

test('findInputs and findOutputs walk one level of category folders', () => {
  const d = tmp();
  const put = (...p: string[]) => { fs.mkdirSync(path.dirname(path.join(d, ...p)), { recursive: true }); fs.writeFileSync(path.join(d, ...p), 'x'); };
  put('top.csv'); put('dealers', 'a.csv'); put('dealers', 'notes.txt'); put('dealers', 'deep', 'z.csv'); put('.hidden', 'h.csv');
  assert.deepEqual(findInputs(d).map((f) => path.relative(d, f)), [path.join('dealers', 'a.csv'), 'top.csv']);
  put('dealers', 'emails', 'a.csv'); put('dealers', 'top-level-ignored.csv'); put('unique', 'u.csv'); put('logs', 'l.csv'); put('.cache', 'c.csv');
  assert.deepEqual([...findOutputs(d)].map(([g, f]) => [g, f.map((x) => path.basename(x))]), [['dealers', ['a.csv']]]);
});

// ---------- audit 2026-10-13 ----------

test('--budget must be more than 0 minutes (B13)', () => {
  assert.throws(() => parseArgs(['--budget=0']), /minutes > 0/);
  assert.equal(parseArgs(['--budget=0.5']).values.get('budget'), 0.5);
});

test('readSites reads UTF-16 files saved by Excel, and names the line of a broken CSV (B10)', () => {
  const dir = tmp();
  const utf16 = path.join(dir, 'u.csv');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\tWebsite\r\nAcme\tacme.co.nz\r\n', 'utf16le')]));
  assert.deepEqual(readSites(utf16).sites, ['https://acme.co.nz/']);
  assert.deepEqual([...readSites(utf16).names], [['https://acme.co.nz/', 'Acme']]);
  assert.deepEqual(readSites(csv('name,website\nBob\'s "best" shop,a.co.nz\n')).sites, ['https://a.co.nz/']); // a stray quote inside a field is fine
  assert.throws(() => readSites(csv('website\na.co.nz\n"b.co.nz" x\n')), /not a readable CSV \(near line 3\)/);
});

test('writeFileAtomic creates files readable by their owner only, and keeps an existing mode (S4)', () => {
  const f = path.join(tmp(), 'x.csv');
  writeFileAtomic(f, 'a');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.chmodSync(f, 0o644);
  writeFileAtomic(f, 'b');
  assert.equal(fs.statSync(f).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(f, 'utf8'), 'b');
});

test('processFile --summary-only: credited rows, shared file, input names and failure details', async () => {
  const dir = tmp();
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, 'name,website\nAlpha Motors,a.com.au\nBeta Motors,b.com.au\nGamma Motors,c.com.au\nDead Motors,dead.com.au\n');
  const layout = fileLayout('dealers', 'list', path.join(dir, 'emails'));
  fs.mkdirSync(layout.cacheDir, { recursive: true });
  const dealer = (h: string): SiteResult => site(`https://${h}/`, { business: 'Home', emails: [
    { email: 'complaints@myfordfinance.com.au', name: null, link: `https://${h}/privacy` },
    { email: `sales@${h}`, name: null, link: `https://${h}/contact` },
  ] });
  writeCacheAtomic(cacheFiles(layout.cacheDir, 'list').cache, [
    dealer('a.com.au'), dealer('b.com.au'), dealer('c.com.au'),
    site('https://dead.com.au/', { pages: 0, error: 'unreachable', errorDetail: 'dns' }),
  ]);
  const opts = { ...DEFAULT_OPTIONS, concurrency: 1, hostConcurrency: 1, revalidateDays: 30 };
  await processFile(input, layout, opts, null, true);
  const rows = parse(fs.readFileSync(layout.outFile, 'utf8'), { columns: true }) as Record<string, string>[];
  assert.deepEqual(rows.map((r) => [r.name, r.email]), [['Alpha Motors', 'sales@a.com.au'], ['Beta Motors', 'sales@b.com.au'], ['Gamma Motors', 'sales@c.com.au']]);
  const shared = parse(fs.readFileSync(layout.sharedFile, 'utf8'), { columns: true }) as Record<string, string>[];
  assert.deepEqual(shared.map((r) => r.email), ['complaints@myfordfinance.com.au']);
  const summary = fs.readFileSync(path.join(layout.logDir, 'list.log'), 'utf8');
  assert.match(summary, /3 unique \(0 person name, 0 department page title, 3 input name, 0 business name\)/);
  assert.match(summary, /Shared {3}: 1 email\(s\) found on 3\+ sites .* -> shared\/list\.csv \(complaints@myfordfinance\.com\.au 3\)/);
  assert.match(summary, /Failures : unreachable=1 \(dns=1\)/);
  assert.match(summary, /dead\.com\.au \[unreachable: dns\]/);
});

test('--retry-capped needs a higher --max-pages, and picks only rows stopped by the page cap (F4)', () => {
  assert.throws(() => retryOptions(parseArgs(['--retry-capped'])), /--max-pages/);
  assert.equal(retryOptions(parseArgs(['--retry-capped', '--max-pages=800'])).capped, true);
  const emails = [{ email: 'a@b.nz', name: null, link: 'x' }];
  const capped = site('c', { v: 3, emails, capQueued: 30, resume: { queued: [['https://c/q', 2]], limited: [], attempts: 400, capped: true } });
  const timed = site('t', { v: 3, emails, budgetQueued: 30, resume: { queued: [['https://t/q', 2]], limited: [], attempts: 120 } });
  assert.equal(cappedRetry(capped), true);
  assert.equal(budgetRetry(capped), false, 'more time would not help a capped site');
  assert.equal(cappedRetry(timed), false);
  const done = new Map([['c', capped], ['t', timed]]);
  assert.deepEqual(Object.fromEntries(planRetries(done, { failed: false, rateLimited: false, budget: false, capped: true }).resume), { c: { budget: false, limited: false, capped: true } });
  assert.deepEqual([...planRetries(done, { failed: false, rateLimited: false, budget: true }).resume.keys()], ['t']);
});

test('every command-line flag is documented in --help (F2)', () => {
  for (const f of [...BOOLEAN_FLAGS, ...INTEGER_FLAGS, ...NUMBER_FLAGS, ...OPTIONAL_NUMBER_FLAGS, ...STRING_FLAGS]) assert.match(USAGE, new RegExp(`--${f}\\b`), f);
});

test('--check-mx drops only domains DNS says cannot receive mail (F3)', async () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  setMxResolver({
    resolveMx: async (d) => {
      if (d === 'acme.co.nz') return [{ exchange: 'mx.acme.co.nz', priority: 10 }];
      if (d === 'nullmx.nz') return [{ exchange: '.', priority: 0 }];
      if (d === 'gone.nz') throw err('ENOTFOUND');
      if (d === 'flaky.nz') throw err('ETIMEOUT');
      throw err('ENODATA');
    },
    resolve4: async (d) => { if (d === 'webonly.nz') return ['93.184.216.34']; throw err('ENODATA'); },
    resolve6: async () => { throw err('ENODATA'); },
  });
  try {
    const bad = await undeliverable(['a@acme.co.nz', 'b@nullmx.nz', 'c@gone.nz', 'd@flaky.nz', 'e@webonly.nz', 'f@nothing.nz']);
    assert.deepEqual([...bad].sort(), ['b@nullmx.nz', 'c@gone.nz', 'f@nothing.nz']);
  } finally {
    setMxResolver(null);
  }
});

test('--dry-run describes each file without writing anything (F2)', () => {
  const dir = tmp();
  const input = path.join(dir, 'websites', 'clinics', 'list.csv');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, 'website\na.nz\nb.nz\nc.nz\n');
  const layout = fileLayout('clinics', 'list', path.join(dir, 'emails'));
  assert.equal(previewFile(input, layout, null, false), 'clinics/list: would scrape 3 sites');
  fs.mkdirSync(layout.cacheDir, { recursive: true });
  const cf = cacheFiles(layout.cacheDir, 'list');
  writeCacheAtomic(cf.cache, [site('https://a.nz/', { emails: [{ email: 'x@a.nz', name: null, link: 'l' }] }), site('https://b.nz/', { error: 'unreachable' })]);
  fs.writeFileSync(cf.marker, '1');
  assert.match(previewFile(input, layout, null, false), /resume an interrupted scrape: 2 of 3 sites cached, 1 to scrape/);
  assert.match(previewFile(input, layout, { failed: true, rateLimited: false, budget: false }, false), /re-crawl 1 and continue 0 of 3 sites, and scrape 1 not scraped yet/);
  assert.match(previewFile(input, layout, null, true), /interrupted; would be skipped/);
  fs.rmSync(cf.marker);
  fs.mkdirSync(layout.emailsDir, { recursive: true });
  fs.writeFileSync(layout.outFile, 'name,email,website,link\n');
  assert.match(previewFile(input, layout, null, false), /would scrape all 3 sites again/);
  assert.match(previewFile(input, layout, null, false, true), /would scrape 1 new sites; 2 cached sites reused/);
  assert.equal(fs.readdirSync(layout.cacheDir).sort().join(), 'list.jsonl', 'nothing written, no lock taken');
  writeCacheAtomic(cf.cache, [site('https://a.nz/'), site('https://b.nz/'), site('https://c.nz/')]);
  assert.match(previewFile(input, layout, null, false, true), /nothing new \(all 3 sites cached\)/);

  fs.writeFileSync(path.join(layout.cacheDir, 'gone.inprogress'), '1');
  fs.writeFileSync(path.join(layout.cacheDir, 'list.lock'), '999999999');
  const stale = staleState([input], path.join(dir, 'emails'));
  assert.equal(stale.length, 2);
  assert.match(stale.join('\n'), /gone\.inprogress: an interrupted scrape whose input list is gone/);
  assert.match(stale.join('\n'), /list\.lock: left by a run that is gone/);
});

// ---------- pages are scraped once per category ----------

const listOpts = { ...DEFAULT_OPTIONS, browserPages: 0, budgetMs: 30_000, concurrency: 1, hostConcurrency: 1, revalidateDays: 30 };
const rowsOf = (file: string) => (parse(fs.readFileSync(file, 'utf8'), { columns: true }) as Record<string, string>[]).map((r) => r.email);

test('the lists of one category share the pages already scraped; another category starts empty', async () => {
  const s = await startServer({
    '/a': page('<a href="/contact">Contact</a>'),
    '/b': page('<a href="/contact">Contact</a>'),
    '/c': page('<a href="/contact?utm_source=x">Contact</a>'),
    '/contact': page('<a href="mailto:info@acme.co.nz">mail</a>'),
  });
  try {
    const dir = tmp();
    const write = (name: string, sites: string[]) => {
      const f = path.join(dir, `${name}.csv`);
      fs.writeFileSync(f, `website\n${sites.map((x) => s.url + x).join('\n')}\n`);
      return f;
    };
    const out = path.join(dir, 'emails');
    const one = fileLayout('clinics', 'one', out), two = fileLayout('clinics', 'two', out), other = fileLayout('shops', 'one', out);

    await processFile(write('one', ['/a']), one, listOpts, null);
    assert.equal(s.hits.filter((h) => h === '/contact').length, 1);
    assert.ok(fs.existsSync(one.pagesFile));
    assert.equal(fs.statSync(one.pagesFile).mode & 0o777, 0o600, 'it holds personal data');

    // a second list of the category, with a tracking param on the link: nothing is requested for the page again
    await processFile(write('two', ['/b', '/c']), two, listOpts, null);
    assert.equal(s.hits.filter((h) => h.startsWith('/contact')).length, 1);
    assert.deepEqual(rowsOf(two.outFile), ['info@acme.co.nz']);
    assert.match(fs.readFileSync(path.join(two.logDir, 'two.log'), 'utf8'), /Crawl {4}: 2 pages fetched \+ 2 reused/);
    closePages();

    // the next run of the category still knows them (a list that grew)
    await processFile(write('two', ['/b', '/c', '/a']), two, listOpts, null, false, true);
    assert.equal(s.hits.filter((h) => h.startsWith('/contact')).length, 1);
    closePages();

    await processFile(write('one', ['/a']), other, listOpts, null);
    assert.equal(s.hits.filter((h) => h === '/contact').length, 2, 'another category has its own pages');
    assert.notEqual(other.pagesFile, one.pagesFile);
  } finally {
    closePages();
    await s.close();
  }
});

test('a fresh re-scrape and --revalidate ask for stored pages again, with their validators', async () => {
  const link = page('<a href="/contact">Contact</a>');
  const s = await startServer({
    '/a': link, '/a2': link, '/a3': link,
    '/contact': { body: page('<a href="mailto:info@acme.co.nz">mail</a>'), headers: { etag: '"v1"' } },
  });
  try {
    const dir = tmp();
    const input = path.join(dir, 'list.csv');
    const sites = (n: number) => fs.writeFileSync(input, `website\n${['/a', '/a2', '/a3'].slice(0, n).map((x) => s.url + x).join('\n')}\n`);
    const layout = fileLayout('clinics', 'list', path.join(dir, 'emails'));
    const asks = () => s.hits.map((h, i) => [h, s.heads[i]['if-none-match']]).filter(([h]) => h === '/contact');

    sites(1);
    await processFile(input, layout, listOpts, null);
    closePages();
    sites(2);
    await processFile(input, layout, listOpts, null, false, true); // the list grew; the stored page is still fresh
    closePages();
    assert.equal(asks().length, 1);

    sites(3);
    await processFile(input, layout, { ...listOpts, revalidateDays: 0 }, null, false, true);
    closePages();
    assert.deepEqual(asks(), [['/contact', undefined], ['/contact', '"v1"']], '--revalidate: asked again, conditionally');

    const sizeBefore = fs.statSync(layout.pagesFile).size;
    await processFile(input, layout, listOpts, null); // output exists, so this is a fresh re-scrape of all three sites
    closePages();
    assert.equal(asks().length, 3, 'a fresh re-scrape asks again, once, and the other sites use that answer');
    assert.ok(fs.statSync(layout.pagesFile).size > sizeBefore, 'older lines are kept, never rewritten');
    assert.deepEqual(rowsOf(layout.outFile), ['info@acme.co.nz']);
  } finally {
    closePages();
    await s.close();
  }
});

test('a category in use by another live run is not scraped (its page store has one writer)', async () => {
  const dir = tmp();
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, 'website\nhttps://example.com/\n');
  const layout = fileLayout('clinics', 'list', path.join(dir, 'emails'));
  fs.mkdirSync(layout.cacheDir, { recursive: true });
  fs.writeFileSync(layout.pagesLock, String(process.ppid)); // a live process that is not this one
  await assert.rejects(processFile(input, layout, listOpts, null), LockedError);
  closePages();
});
