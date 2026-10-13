import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SiteResult } from '../src/crawler.js';
import { budgetHits, markRow, resolveCacheId } from '../scripts/mark-budget-from-logs.js';

const line = (o: Record<string, unknown>) => JSON.stringify({ level: 30, msg: 'time budget used up after 76 pages (141 still queued)', ...o });
const row = (extra: Partial<SiteResult> = {}): SiteResult => ({
  v: 2, site: 'https://a.org/', finalUrl: 'https://a.org/', business: 'A', emails: [], pages: 76, usedBrowser: false, ...extra,
});

test('budgetHits keeps the latest time-limit line per file and site', () => {
  const hits = budgetHits([
    line({ time: '2026-10-04T01:00:00Z', file: 'churches/au.churches', site: 'https://a.org/', pages: 10, queued: 5 }),
    line({ time: '2026-10-13T01:00:00Z', file: 'churches/au.churches', site: 'https://a.org/', pages: 76, queued: 141 }),
    line({ time: '2026-10-13T01:00:00Z', file: 'au.wet-n-wild', site: 'https://b.com/', pages: 29, queued: 73, msg: 'stopped at the hard time limit after 29 pages' }),
    JSON.stringify({ time: '2026-10-13T01:00:00Z', file: 'x', site: 'https://c.com/', msg: 'site started' }),
    'not json but time budget used up',
  ]);
  assert.deepEqual(hits.map((h) => [h.file, h.pages, h.queued]), [['churches/au.churches', 76, 141], ['au.wet-n-wild', 29, 73]]);
});

test('resolveCacheId maps a pre-category log id to the one group that has it', () => {
  const groups = new Map([['au.wet-n-wild', ['entertainments']], ['au.x', ['a', 'b']]]);
  assert.equal(resolveCacheId('churches/au.churches', groups), 'churches/au.churches');
  assert.equal(resolveCacheId('au.wet-n-wild', groups), 'entertainments/au.wet-n-wild');
  assert.equal(resolveCacheId('au.x', groups), null);
  assert.equal(resolveCacheId('au.none', groups), null);
});

test('markRow marks only a row that still matches the log line', () => {
  const hit = { file: 'f', site: 'https://a.org/', pages: 76, queued: 141, time: 't' };
  assert.deepEqual(markRow(row(), hit), { row: { ...row(), budgetQueued: 141 } });
  assert.ok('row' in markRow(row({ pages: 90, usedBrowser: true }), hit)); // the browser phase added pages
  assert.match((markRow(row({ pages: 120 }), hit) as { skip: string }).skip, /scraped again since/);
  assert.match((markRow(row({ v: 3 }), hit) as { skip: string }).skip, /scraped again since/);
  assert.match((markRow(row({ budgetQueued: 5 }), hit) as { skip: string }).skip, /already marked/);
  assert.match((markRow(undefined, hit) as { skip: string }).skip, /not in the cache/);
});
