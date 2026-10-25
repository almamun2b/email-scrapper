import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { cacheFiles, writeCacheAtomic } from '../src/cache.js';
import { LIST_FLAGS, parseArgs, suffixFilter, USAGE } from '../src/cli.js';
import { DEFAULT_OPTIONS, type SiteResult } from '../src/crawler.js';
import { describeFilter, filterRows, filterTag, keepEmail, matchesSuffix, parseSuffixes } from '../src/filter.js';
import { fileLayout } from '../src/paths.js';
import { filterFile, filteredPath, previewFile, processFile, writeUnique } from '../src/run.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-filter-'));
const site = (s: string, emails: string[]): SiteResult => ({
  site: s, finalUrl: s, business: 'Biz', pages: 1, usedBrowser: false, emails: emails.map((email) => ({ email, name: null, link: `${s}contact` })),
});
const readCsv = (file: string) => (parse(fs.readFileSync(file, 'utf8'), { columns: true }) as Record<string, string>[]).map((r) => r.email);

test('parseSuffixes: case, leading dot, spaces and a trailing comma are tolerated; junk is not', () => {
  assert.deepEqual(parseSuffixes('.COM, net,.gov.au,', 'include-suffix'), ['com', 'net', 'gov.au']);
  assert.throws(() => parseSuffixes('.com,@evil', 'include-suffix'), /not a domain suffix/);
  assert.throws(() => parseSuffixes('a..b', 'exclude-suffix'), /not a domain suffix/);
});

test('parseArgs reads --x=a,b, --x a,b and --x[a,b], and repeated flags add up', () => {
  for (const argv of [['--include-suffix=.com,.net'], ['--include-suffix', '.com,.net'], ['--include-suffix[.com,.net,]']]) {
    assert.deepEqual(suffixFilter(parseArgs(argv)), { include: ['com', 'net'], exclude: [] }, argv.join(' '));
  }
  const both = suffixFilter(parseArgs(['--include-suffix=.au', '--exclude-suffix[.gov.au]', '--include-suffix=.nz', 'x.csv']))!;
  assert.deepEqual(both, { include: ['au', 'nz'], exclude: ['gov.au'] });
  assert.deepEqual(parseArgs(['--include-suffix=.au', 'x.csv']).files, ['x.csv']);
  assert.equal(suffixFilter(parseArgs(['--force'])), null);
  assert.throws(() => parseArgs(['--include-suffix']), /needs a list/);
  assert.throws(() => parseArgs(['--exclude-suffix=,']), /at least one suffix/);
});

test('the country filters are not options', () => {
  assert.throws(() => parseArgs(['--include-country=.au']), /Unknown option/);
});

test('matchesSuffix works on whole labels: .au matches x.com.au, not x.nau; .gov does not match x.gov.au', () => {
  assert.ok(matchesSuffix('x.com.au', 'au'));
  assert.ok(matchesSuffix('au', 'au'));
  assert.ok(!matchesSuffix('x.nau', 'au'));
  assert.ok(!matchesSuffix('x.gov.au', 'gov'));
  assert.ok(matchesSuffix('health.gov.au', 'gov.au'));
  assert.ok(matchesSuffix('health.gov', 'gov'));
});

test('keepEmail: include only, exclude only, both; generic .com addresses are plain suffixes', () => {
  const inc = { include: ['com', 'net', 'au'], exclude: [] };
  assert.deepEqual(['a@x.com', 'a@x.com.au', 'a@x.de', 'a@x.org'].filter((e) => keepEmail(e, inc)), ['a@x.com', 'a@x.com.au']);
  const exc = { include: [], exclude: ['gov', 'edu', 'de'] };
  assert.deepEqual(['a@x.com', 'a@x.gov', 'a@x.de', 'a@x.gov.au', 'a@Y.EDU'].filter((e) => keepEmail(e, exc)), ['a@x.com', 'a@x.gov.au']);
  const both = { include: ['au'], exclude: ['gov.au'] };
  assert.deepEqual(['a@x.com.au', 'a@x.gov.au', 'a@x.com'].filter((e) => keepEmail(e, both)), ['a@x.com.au']);
});

test('filterTag and describeFilter ignore order and duplicates', () => {
  assert.equal(filterTag({ include: ['net', 'com', 'com'], exclude: [] }), 'include-suffix-com-net');
  assert.equal(filterTag({ include: ['au'], exclude: ['gov.au', 'edu'] }), 'include-suffix-au_exclude-suffix-edu-gov.au');
  assert.equal(describeFilter({ include: ['nz', 'au'], exclude: ['gov.au'] }), 'include .au, .nz; exclude .gov.au');
});

test('filterRows counts what it dropped per domain ending', () => {
  const rows = [['A', 'a@x.com', '', ''], ['B', 'b@y.gov.au', '', ''], ['C', 'c@z.gov.au', '', ''], ['D', 'd@q.de', '', '']] as [string, string, string, string][];
  const { kept, dropped } = filterRows(rows, { include: [], exclude: ['gov.au', 'de'] });
  assert.deepEqual(kept.map((r) => r[1]), ['a@x.com']);
  assert.deepEqual(Object.fromEntries(dropped), { 'gov.au': 2, de: 1 });
});

test('every list flag is documented in --help', () => {
  for (const f of LIST_FLAGS) assert.match(USAGE, new RegExp(`--${f}\\b`), f);
});

function setup() {
  const dir = tmp();
  const input = path.join(dir, 'list.csv');
  fs.writeFileSync(input, 'name,website\nAlpha,a.com.au\nBeta,b.com\n');
  const layout = fileLayout('dealers', 'list', path.join(dir, 'results'));
  fs.mkdirSync(layout.cacheDir, { recursive: true });
  writeCacheAtomic(cacheFiles(layout.cacheDir, 'list').cache, [
    site('https://a.com.au/', ['sales@a.com.au', 'info@health.gov.au']),
    site('https://b.com/', ['hi@b.com', 'x@b.de']),
  ]);
  const opts = { ...DEFAULT_OPTIONS, concurrency: 1, hostConcurrency: 1, revalidateDays: 30 };
  return { dir, input, layout, opts };
}

test('processFile --summary-only with a filter: full CSV, filtered CSV, and a log block', async () => {
  const { input, layout, opts } = setup();
  const filter = { include: [], exclude: ['gov.au', 'de'] };
  await processFile(input, layout, { ...opts, filter }, null, true);
  assert.deepEqual(readCsv(layout.outFile), ['sales@a.com.au', 'info@health.gov.au', 'hi@b.com', 'x@b.de']);
  const filtered = filteredPath(layout, filter);
  assert.equal(path.dirname(filtered), path.join(layout.emailsDir, 'filtered'));
  assert.deepEqual(readCsv(filtered), ['sales@a.com.au', 'hi@b.com']);
  const log = fs.readFileSync(path.join(layout.logDir, 'list.log'), 'utf8');
  assert.match(log, /filtered \(exclude \.de, \.gov\.au\)/);
  assert.match(log, /Emails {3}: 2 of 4 kept/);
  assert.match(log, /Dropped {2}: 2 \(/);
});

test('filterFile writes only the filtered CSV from the cache, leaving the normal CSV alone', async () => {
  const { input, layout, opts } = setup();
  fs.mkdirSync(layout.emailsDir, { recursive: true });
  fs.writeFileSync(layout.outFile, 'name,email,website,link\nOld,old@a.com.au,https://a.com.au/,l\n');
  const filter = { include: ['au'], exclude: [] };
  await filterFile(input, layout, { ...opts, filter });
  assert.equal(fs.readFileSync(layout.outFile, 'utf8'), 'name,email,website,link\nOld,old@a.com.au,https://a.com.au/,l\n');
  assert.deepEqual(readCsv(filteredPath(layout, filter)), ['sales@a.com.au', 'info@health.gov.au']);
  assert.ok(!fs.existsSync(cacheFiles(layout.cacheDir, 'list').lock), 'the list lock is released');
});

test('filterFile skips a list with no cache or an interrupted scrape', async () => {
  const { input, layout, opts } = setup();
  const filter = { include: ['au'], exclude: [] };
  fs.writeFileSync(cacheFiles(layout.cacheDir, 'list').marker, '');
  await filterFile(input, layout, { ...opts, filter });
  fs.rmSync(cacheFiles(layout.cacheDir, 'list').marker);
  fs.rmSync(cacheFiles(layout.cacheDir, 'list').cache);
  await filterFile(input, layout, { ...opts, filter });
  assert.ok(!fs.existsSync(filteredPath(layout, filter)));
});

test('writeUnique with a filter also writes unique/<label>.<tag>.csv', () => {
  const out = path.join(tmp(), 'results');
  const a = fileLayout('dealers', 'a', out);
  const b = fileLayout('dealers', 'b', out);
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(a.outFile, 'name,email,website,link\nA,sales@a.com.au,https://a.com.au/,l\nG,x@health.gov.au,https://a.com.au/,l\n');
  put(b.outFile, 'name,email,website,link\nB,x@health.gov.au,https://b.com.au/,l\nC,help@b.de,https://b.com.au/,l\n');
  const target = path.join(a.uniqueDir, 'dealers.csv');
  const filter = { include: [], exclude: ['gov.au', 'de'] };
  writeUnique([{ id: 'a', file: a.outFile }, { id: 'b', file: b.outFile }], 'dealers', target, a.logDir, filter);
  assert.deepEqual(readCsv(target), ['sales@a.com.au', 'x@health.gov.au', 'help@b.de']);
  assert.deepEqual(readCsv(path.join(a.uniqueDir, 'dealers.exclude-suffix-de-gov.au.csv')), ['sales@a.com.au']);
  assert.match(fs.readFileSync(path.join(a.logDir, 'unique.dealers.log'), 'utf8'), /unique dealers filtered \(exclude \.de, \.gov\.au\)/);
});

test('--dry-run names the filtered CSV', () => {
  const { input, layout } = setup();
  const filter = { include: ['au'], exclude: [] };
  const text = previewFile(input, layout, null, true, false, filter);
  assert.match(text, /then would write the filtered CSV .*filtered.*list\.include-suffix-au\.csv/);
  assert.doesNotMatch(previewFile(input, layout, null, true, false), /filtered CSV/);
});
