import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildList, currentListName, isBlocked, nextListName } from '../scripts/new-list.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scraper-newlist-'));

test('nextListName: base first, then -2, -3 without touching existing files', () => {
  const dir = tmp();
  assert.equal(nextListName(dir, 'pizza-shops', 'au'), 'pizza-shops.au.csv');
  fs.writeFileSync(path.join(dir, 'pizza-shops.au.csv'), 'name,website\n');
  assert.equal(nextListName(dir, 'pizza-shops', 'au'), 'pizza-shops-2.au.csv');
  fs.writeFileSync(path.join(dir, 'pizza-shops-2.au.csv'), 'name,website\n');
  assert.equal(nextListName(dir, 'pizza-shops', 'au'), 'pizza-shops-3.au.csv');
  assert.equal(nextListName(dir, 'pizza-chains', 'au'), 'pizza-chains.au.csv');
  assert.equal(nextListName(dir, 'pizza-shops', 'nz'), 'pizza-shops.nz.csv');
});

test('buildList: drops known sites, platforms, invalid and repeated candidates', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pizza-shops.au.csv'), 'name,website\nOld,https://www.oldpizza.com.au\n');
  const cand = path.join(tmp(), 'c.csv');
  fs.writeFileSync(cand, [
    'name,website',
    'Old again,http://oldpizza.com.au/',
    'New,https://newpizza.com.au/#top',
    'New twice,https://www.newpizza.com.au',
    'Insta,https://instagram.com/somepizza',
    'Uber,https://www.ubereats.com/store/x',
    'Bad,not a url',
    'Other,https://luigis.co.nz/menu',
  ].join('\n'));
  const r = buildList(dir, 'pizza-shops', 'au', cand);
  assert.equal(path.basename(r.file), 'pizza-shops-2.au.csv');
  assert.deepEqual(r.rows, [{ name: 'New', website: 'https://newpizza.com.au' }, { name: 'Other', website: 'https://luigis.co.nz/menu' }]);
  assert.deepEqual([r.known, r.blocked, r.invalid, r.repeated], [1, 2, 1, 1]);
  assert.equal(fs.readdirSync(dir).length, 1); // buildList writes nothing
});

test('isBlocked: matches the registrable domain, not lookalikes', () => {
  assert.equal(isBlocked('https://m.facebook.com/x'), true);
  assert.equal(isBlocked('https://www.menulog.com.au/'), true);
  assert.equal(isBlocked('https://facebookpizza.com.au/'), false);
  assert.equal(isBlocked('https://venues.posbosshq.com/NZ/my-store-4867'), true);
  assert.equal(isBlocked('https://pizzabros.co.nz/'), false);
  assert.equal(isBlocked('http://clunesps.vic.edu.au'), true);
  assert.equal(isBlocked('https://www.ozfoodhunter.com.au/euro-pizza'), true);
  assert.equal(isBlocked('https://forestopizza.square.site'), false);
});

test('currentListName / append: later batches target the numbered file, never the base list', () => {
  const dir = tmp();
  assert.equal(currentListName(dir, 'pizza-shops', 'au'), null);
  fs.writeFileSync(path.join(dir, 'pizza-shops.au.csv'), 'name,website\nA,https://a.com.au\n');
  assert.equal(currentListName(dir, 'pizza-shops', 'au'), null);
  const cand = path.join(tmp(), 'cand.csv');
  fs.writeFileSync(cand, 'name,website\nB,https://b.com.au\n');
  assert.equal(path.basename(buildList(dir, 'pizza-shops', 'au', cand, true).file), 'pizza-shops-2.au.csv');
  fs.writeFileSync(path.join(dir, 'pizza-shops-2.au.csv'), 'name,website\nB,https://b.com.au\n');
  assert.equal(currentListName(dir, 'pizza-shops', 'au'), 'pizza-shops-2.au.csv');
  fs.writeFileSync(cand, 'name,website\nB,https://b.com.au\nC,https://c.com.au\n');
  const r = buildList(dir, 'pizza-shops', 'au', cand, true);
  assert.equal(path.basename(r.file), 'pizza-shops-2.au.csv');
  assert.deepEqual(r.rows.map((x) => x.website), ['https://c.com.au']);
  assert.equal(path.basename(buildList(dir, 'pizza-shops', 'au', cand).file), 'pizza-shops-3.au.csv');
});
