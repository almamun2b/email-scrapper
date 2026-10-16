import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PageStore, type PageRecord } from '../src/pages.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pages-')), '.pages');
const rec = (url: string, email = 'a@x.nz', at = Date.now()): PageRecord => ({ url, emails: [{ email, name: 'Ann Lee', source: 'mailto', nameFrom: 'page' }], title: 'Sales', links: ['/about', 'https://x.nz/b?p=1'], at });
const load = (s: PageStore, key: string, fetch: (stale?: PageRecord) => Promise<PageRecord | null>, cutoff = 0, mode: 'h' | 'b' = 'h') => s.load(mode, key, cutoff, fetch);

test('a stored page is read back, also by a later run', async () => {
  const file = tmp();
  const a = new PageStore(file);
  const r1 = rec('https://x.nz/a'), r2 = rec('https://x.nz/ü/é', 'ü@x.nz');
  await load(a, 'x.nz/a', async () => r1);
  await load(a, 'x.nz/ü/é', async () => r2);
  assert.deepEqual(a.get('h', 'x.nz/a'), r1);
  a.close();

  const b = new PageStore(file);
  assert.equal(b.pages, 2);
  assert.deepEqual(b.get('h', 'x.nz/a'), r1);
  assert.deepEqual(b.get('h', 'x.nz/ü/é'), r2);
  const r3 = rec('https://x.nz/c');
  await load(b, 'x.nz/c', async () => r3); // appending after a reload keeps every offset right
  assert.deepEqual(b.get('h', 'x.nz/c'), r3);
  assert.deepEqual(b.get('h', 'x.nz/a'), r1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'it holds personal data');
  b.close();
});

test('a stored page is not fetched again; HTTP and browser pages are kept apart', async () => {
  const s = new PageStore(tmp());
  let fetches = 0;
  const fetch = async () => { fetches++; return rec('https://x.nz/a'); };
  assert.equal((await load(s, 'x.nz/a', fetch) as { reused: boolean }).reused, false);
  assert.equal((await load(s, 'x.nz/a', fetch) as { reused: boolean }).reused, true);
  assert.equal(fetches, 1);
  assert.equal((await load(s, 'x.nz/a', fetch, 0, 'b') as { reused: boolean }).reused, false, 'the browser renders what HTTP cannot');
  assert.equal(fetches, 2);
  s.close();
});

test('a page older than the cutoff is fetched again, given its old copy; the new copy replaces it', async () => {
  const file = tmp();
  const s = new PageStore(file);
  await load(s, 'x.nz/a', async () => ({ ...rec('https://x.nz/a', 'old@x.nz', 1_000), etag: '"v1"' }));
  let seen: PageRecord | undefined;
  const got = await load(s, 'x.nz/a', async (stale) => { seen = stale; return rec('https://x.nz/a', 'new@x.nz', 5_000); }, 2_000);
  assert.equal(seen?.etag, '"v1"');
  assert.ok(got && got !== 'gone' && !got.reused);
  assert.equal(s.get('h', 'x.nz/a')?.emails[0].email, 'new@x.nz');
  // within the cutoff now: reused, and a reload agrees (the last line wins)
  assert.ok((await load(s, 'x.nz/a', async () => assert.fail('fetched again'), 2_000) as { reused: boolean }).reused);
  s.close();
  assert.equal(new PageStore(file).get('h', 'x.nz/a')?.emails[0].email, 'new@x.nz');
});

test('a revalidated page is stored again with its new time, unchanged', async () => {
  const s = new PageStore(tmp());
  await load(s, 'x.nz/a', async () => rec('https://x.nz/a', 'a@x.nz', 1_000));
  await load(s, 'x.nz/a', async (stale) => ({ ...stale!, at: 9_000 }), 5_000); // 304: the old copy is current
  const copy = s.get('h', 'x.nz/a')!;
  assert.equal(copy.at, 9_000);
  assert.equal(copy.emails[0].email, 'a@x.nz');
  assert.ok((await load(s, 'x.nz/a', async () => assert.fail('fetched again'), 9_000) as { reused: boolean }).reused);
  s.close();
});

test('a 404 is remembered, also across runs, until it goes stale', async () => {
  const file = tmp();
  const a = new PageStore(file);
  const notFound = async () => { a.markGone('h', 'x.nz/old', 1_000); return null; };
  assert.equal(await load(a, 'x.nz/old', notFound), 'gone');
  assert.equal(await load(a, 'x.nz/old', async () => assert.fail('asked again')), 'gone');
  a.close();
  const b = new PageStore(file);
  assert.equal(await load(b, 'x.nz/old', async () => assert.fail('asked again')), 'gone');
  assert.equal(await load(b, 'x.nz/old', async () => rec('https://x.nz/old'), 2_000).then((g) => g !== 'gone' && !!g), true, 'stale: asked again, and it exists now');
  b.close();
});

test('a record cut off by a crash is ignored, and the next one starts on its own line', async () => {
  const file = tmp();
  const a = new PageStore(file);
  const r1 = rec('https://x.nz/a');
  await load(a, 'x.nz/a', async () => r1);
  a.close();
  fs.appendFileSync(file, 'hx.nz/b\t123\t{"url":"https://x.nz/b","emails":[{"em'); // no newline, unfinished JSON
  const b = new PageStore(file);
  assert.equal(b.get('h', 'x.nz/b'), undefined);
  assert.deepEqual(b.get('h', 'x.nz/a'), r1);
  const r3 = rec('https://x.nz/c');
  await load(b, 'x.nz/c', async () => r3);
  b.close();
  const c = new PageStore(file);
  assert.deepEqual(c.get('h', 'x.nz/c'), r3);
  assert.deepEqual(c.get('h', 'x.nz/a'), r1);
  c.close();
});

test('load() fetches a page once, however many sites ask for it at the same time', async () => {
  const s = new PageStore(tmp());
  let fetches = 0;
  const fetch = async () => { fetches++; await new Promise((r) => setTimeout(r, 30)); return rec('https://x.nz/a'); };
  const got = await Promise.all([1, 2, 3, 4].map(() => load(s, 'x.nz/a', fetch)));
  assert.equal(fetches, 1);
  assert.deepEqual(got.map((g) => g !== 'gone' && g?.reused), [false, true, true, true]);
  s.close();
});

test('load(): sites waiting on a failed fetch try the page themselves, and a crash does not reject them', async () => {
  const s = new PageStore(tmp());
  let calls = 0;
  const flaky = async () => {
    const n = ++calls;
    await new Promise((r) => setTimeout(r, 20));
    if (n === 1) throw new Error('boom');
    return rec('https://x.nz/a');
  };
  const [first, second] = await Promise.allSettled([load(s, 'x.nz/a', flaky), load(s, 'x.nz/a', flaky)]);
  assert.equal(first.status, 'rejected');
  assert.equal(second.status, 'fulfilled');
  assert.equal(calls, 2);
  s.close();
});

test('load() answers "gone" to everyone once one site has seen the 404', async () => {
  const s = new PageStore(tmp());
  const notFound = async () => { s.markGone('h', 'x.nz/old'); return null; };
  assert.deepEqual(await Promise.all([load(s, 'x.nz/old', notFound), load(s, 'x.nz/old', notFound)]), ['gone', 'gone']);
  s.close();
});

test('put() writes a landing page only when the store has none or an older one', async () => {
  const s = new PageStore(tmp());
  s.put('h', 'x.nz/', rec('https://x.nz/', 'first@x.nz', 1_000));
  s.put('h', 'x.nz/', rec('https://x.nz/', 'second@x.nz', 2_000), 500);
  assert.equal(s.get('h', 'x.nz/')?.emails[0].email, 'first@x.nz');
  s.put('h', 'x.nz/', rec('https://x.nz/', 'third@x.nz', 3_000), 1_500);
  assert.equal(s.get('h', 'x.nz/')?.emails[0].email, 'third@x.nz');
  s.close();
});

test('sitemap() loads an origin once per run, and forgets a load that was cut short', async () => {
  const s = new PageStore(tmp());
  let loads = 0;
  const load1 = async () => { loads++; return ['https://x.nz/a']; };
  await Promise.all([s.sitemap('https://x.nz', load1, () => true), s.sitemap('https://x.nz', load1, () => true)]);
  assert.equal(loads, 1);
  await s.sitemap('https://y.nz', load1, () => false);
  await new Promise((r) => setImmediate(r));
  await s.sitemap('https://y.nz', load1, () => true);
  assert.equal(loads, 3);
  s.close();
});
