import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { page, startServer, type Route } from './helpers/server.js';
import { untilAborted } from '../src/abort.js';
import { makeBrowserFetcher } from '../src/browser.js';
import { failedRetry } from '../src/cache.js';
import { closeBrowser, mergeResults, resumeSite, scrapeSite, type SiteResult } from '../src/crawler.js';
import { hostGapMs, httpGet, resetHostPacing, setCrawlDelay } from '../src/http.js';

after(() => closeBrowser());

const NO_BROWSER = { browserPages: 0, budgetMs: 30_000 };

async function chromiumAvailable(): Promise<boolean> {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

test('a link with a malformed % escape does not crash the site (H1)', async () => {
  const s = await startServer({
    '/': page('<a href="mailto:info@acme.co.nz">mail</a><a href="/about">About</a><a href="/100%-satisfaction">Promise</a>'),
    '/about': page('<p>craig.kirkland@acme.co.nz</p>'),
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.emails.map((e) => e.email).sort(), ['craig.kirkland@acme.co.nz', 'info@acme.co.nz']);
  } finally {
    await s.close();
  }
});

test('robots.txt disallowing the start page gives robots-disallowed', async () => {
  const s = await startServer({
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /\n' },
    '/': page('<a href="mailto:info@acme.co.nz">mail</a>'),
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.error, 'robots-disallowed');
    assert.ok(!s.hits.includes('/'));
  } finally {
    await s.close();
  }
});

const emailsOf = (r: { emails: { email: string }[] }) => r.emails.map((e) => e.email).sort();

test('robots.txt answering 5xx means keep out (RFC 9309), reported as robots-unavailable so it can be retried (B9)', async () => {
  const s = await startServer({
    '/robots.txt': { status: 500, body: 'oops' },
    '/': page('<a href="mailto:info@acme.co.nz">mail</a>'),
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.error, 'robots-unavailable');
    assert.ok(!s.hits.includes('/'));
    assert.equal(failedRetry(r), true);
  } finally {
    await s.close();
  }
});

test('a page redirecting off the site is not ingested (L5)', async () => {
  const other = await startServer({ '/team': page('<p>outsider@agency.co.nz</p>') }, '127.0.0.2');
  const s = await startServer({
    '/': page('<a href="mailto:info@acme.co.nz">mail</a><a href="/partner">Partner</a><a href="/old-team">Team</a>'),
    '/partner': { redirect: other.url + '/team' },
    '/old-team': { redirect: '/team' },
    '/team': page('<p>jo.bloggs@acme.co.nz</p>'),
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.deepEqual(emailsOf(r), ['info@acme.co.nz', 'jo.bloggs@acme.co.nz']);
    assert.equal(s.hits.filter((h) => h === '/team').length, 1); // the redirect target isn't fetched twice
  } finally {
    await s.close();
    await other.close();
  }
});

test('gzipped sitemaps seed the crawl; a bad <loc> skips only itself (L7)', async () => {
  const routes: Record<string, Route> = {
    '/': page('<p>Nothing linked here</p>'),
    '/hidden-contact': page('<p>hidden@acme.co.nz</p>'),
  };
  const s = await startServer(routes);
  routes['/sitemap.xml'] = {
    type: 'application/xml',
    body: `<sitemapindex><sitemap><loc>http://[bad</loc></sitemap><sitemap><loc>${s.url}/pages-sitemap.xml.gz</loc></sitemap></sitemapindex>`,
  };
  routes['/pages-sitemap.xml.gz'] = {
    type: 'application/x-gzip',
    body: gzipSync(`<urlset><url><loc>${s.url}/hidden-contact</loc></url></urlset>`),
  };
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.deepEqual(emailsOf(r), ['hidden@acme.co.nz']);
  } finally {
    await s.close();
  }
});

test('non-HTML responses are not downloaded or scanned (L9)', async () => {
  const s = await startServer({
    '/': page('<a href="mailto:info@acme.co.nz">mail</a><a href="/brochure">Brochure</a>'),
    '/brochure': { type: 'application/pdf', body: 'pdf-ish secret@acme.co.nz' },
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.deepEqual(emailsOf(r), ['info@acme.co.nz']);
    assert.equal(r.pages, 1); // the PDF isn't counted as a fetched page (L4)
  } finally {
    await s.close();
  }
});

test('pages in a legacy charset are decoded (L9)', async () => {
  const html = page('<div class="card"><h3>José Martínez</h3><p>jmartinez@acme.co.nz</p></div><div><h3>Other Person</h3></div>');
  const s = await startServer({ '/': { type: 'text/html; charset=windows-1252', body: Buffer.from(html, 'latin1') } });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.emails[0]?.name, 'José Martínez');
  } finally {
    await s.close();
  }
});

test('aborting a scrape returns what it found so far (M5)', async () => {
  const links = Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">p</a>`).join('');
  const routes: Record<string, Route> = { '/': page(`<a href="mailto:info@acme.co.nz">mail</a>${links}`) };
  for (let i = 0; i < 20; i++) routes[`/p${i}`] = { body: page(`<p>p${i}@acme.co.nz</p>`), delayMs: 300 };
  const s = await startServer(routes);
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 500);
    const t0 = Date.now();
    const r = await scrapeSite(s.url + '/', NO_BROWSER, ctl.signal);
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(r.error, 'timeout');
    assert.ok(emailsOf(r).includes('info@acme.co.nz'));
    assert.ok(r.emails.length < 21);
    // pages cut off mid-fetch go back into the saved queue: every page is either fetched or still queued
    assert.equal(r.emails.length - 1 + (r.resume?.queued.length ?? 0), 20);
    assert.equal(r.budgetQueued, r.resume?.queued.length);
  } finally {
    await s.close();
  }
});

test('robots.txt Crawl-delay spaces out requests', async () => {
  const s = await startServer({
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nCrawl-delay: 1\n' },
    '/': page('<a href="/a">a</a><a href="/b">b</a><p>info@acme.co.nz</p>'),
    '/a': page('<p>a@acme.co.nz</p>'),
    '/b': page('<p>b@acme.co.nz</p>'),
  });
  try {
    const t0 = Date.now();
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.emails.length, 3);
    assert.ok(Date.now() - t0 >= 2000, 'three page requests one second apart');
  } finally {
    resetHostPacing();
    await s.close();
  }
});

test('browser fallback also runs for http:// inputs (M3)', { skip: !(await chromiumAvailable()) && 'Chromium not installed' }, async () => {
  const s = await startServer({
    '/': `<html><body><div id="app"></div><script>document.getElementById('app').innerHTML = '<a href="mailto:js@acme.co.nz">Email</a>';</script></body></html>`,
  });
  try {
    const r = await scrapeSite(s.url + '/', { browserPages: 5, budgetMs: 60_000 });
    assert.equal(r.usedBrowser, true);
    assert.deepEqual(emailsOf(r), ['js@acme.co.nz']);
  } finally {
    await s.close();
  }
});

test('pages refused with 429 are counted, and the rest of the site is kept', async () => {
  const limited = { status: 429, headers: { 'retry-after': '1' }, body: '' };
  const s = await startServer({
    '/': page('<a href="mailto:info@acme.co.nz">mail</a><a href="/team">Team</a><a href="/contact">Contact</a>'),
    '/team': limited,
    '/contact': limited,
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.rateLimited, 2);
    assert.deepEqual(emailsOf(r), ['info@acme.co.nz']);
  } finally {
    resetHostPacing();
    await s.close();
  }
});

test('a server answering 429 is slowed down, then sped up again by normal answers', async () => {
  const s = await startServer({
    '/busy': { status: 429, headers: { 'retry-after': '1' }, body: '' },
    '/ok': page('<p>fine</p>'),
  });
  try {
    assert.equal(hostGapMs('127.0.0.1'), 0);
    assert.equal((await httpGet(s.url + '/busy'))?.status, 429); // refused twice (with the one retry): 1 s, then 2 s
    assert.equal(hostGapMs('127.0.0.1'), 2000);
    setCrawlDelay('127.0.0.1', 5);
    assert.equal(hostGapMs('127.0.0.1'), 5000, 'a larger robots Crawl-delay still wins');
    resetHostPacing();
    assert.equal((await httpGet(s.url + '/busy'))?.status, 429);
    assert.equal((await httpGet(s.url + '/ok'))?.status, 200);
    assert.equal(hostGapMs('127.0.0.1'), 1000);
    assert.equal((await httpGet(s.url + '/ok'))?.status, 200);
    assert.equal(hostGapMs('127.0.0.1'), 0);
  } finally {
    resetHostPacing();
    await s.close();
  }
});

// ---------- saved queues and resuming ----------

test('a site that runs out of time saves its queue, and resumeSite fetches only what was left', async () => {
  const links = Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">p</a>`).join('');
  const routes: Record<string, Route> = { '/': page(`<a href="mailto:info@acme.co.nz">mail</a>${links}`) };
  for (let i = 0; i < 8; i++) routes[`/p${i}`] = { body: page(`<p>p${i}@acme.co.nz</p>`), delayMs: 250 };
  const s = await startServer(routes);
  try {
    const r = await scrapeSite(s.url + '/', { browserPages: 0, budgetMs: 400, pageConcurrency: 1 });
    assert.equal(r.error, undefined);
    assert.ok(r.budgetQueued && r.budgetQueued > 0 && r.budgetQueued < 8, `queued ${r.budgetQueued}`);
    assert.equal(r.resume?.queued.length, r.budgetQueued);
    assert.equal(r.resume?.attempts, r.pages); // the landing page plus every page fetched

    const r2 = await resumeSite(r, { budget: true, limited: false }, { browserPages: 0, budgetMs: 30_000 });
    assert.deepEqual(emailsOf(r2), ['info@acme.co.nz', ...Array.from({ length: 8 }, (_, i) => `p${i}@acme.co.nz`)].sort());
    assert.equal(r2.pages, 9);
    assert.equal(r2.budgetQueued, undefined);
    assert.equal(r2.resume, undefined);
    assert.equal(s.hits.filter((h) => h === '/').length, 1, 'the landing page is not fetched again');
    for (let i = 0; i < 8; i++) assert.equal(s.hits.filter((h) => h === `/p${i}`).length, 1, `/p${i} fetched once`);
  } finally {
    await s.close();
  }
});

test('rate-limited pages are saved, and resumeSite retries just them and the links they lead to', async () => {
  const routes: Record<string, Route> = {
    '/': page('<a href="mailto:info@acme.co.nz">mail</a><a href="/team">Team</a><a href="/contact">Contact</a>'),
    '/team': { status: 429, headers: { 'retry-after': '1' }, body: '' },
    '/contact': page('<p>contact@acme.co.nz</p>'),
  };
  const s = await startServer(routes);
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.rateLimited, 1);
    assert.deepEqual(r.resume?.limited, [[s.url + '/team', 1]]);
    assert.deepEqual(r.resume?.queued, []);
    resetHostPacing();

    routes['/team'] = page('<p>team@acme.co.nz</p><a href="/staff">Staff</a><a href="/contact">Contact</a>');
    routes['/staff'] = page('<p>staff@acme.co.nz</p>');
    const mark = s.hits.length;
    const r2 = await resumeSite(r, { budget: false, limited: true }, NO_BROWSER);
    assert.deepEqual(s.hits.slice(mark), ['/team', '/staff']);
    assert.deepEqual(emailsOf(r2), ['contact@acme.co.nz', 'info@acme.co.nz', 'staff@acme.co.nz', 'team@acme.co.nz']);
    assert.equal(r2.rateLimited, undefined);
    assert.equal(r2.resume, undefined);
    assert.equal(r2.pages, r.pages + 2);
  } finally {
    resetHostPacing();
    await s.close();
  }
});

/** A v3 row as a time-limited, rate-limited crawl of `url` would have left it. */
function savedRow(url: string, extra: Partial<SiteResult> = {}): SiteResult {
  return {
    v: 3, site: url + '/', finalUrl: url + '/', business: 'Acme', pages: 2, usedBrowser: false, rateLimited: 1, budgetQueued: 1,
    emails: [{ email: 'info@acme.co.nz', name: null, link: url + '/' }],
    resume: { queued: [[url + '/q', 1]], limited: [[url + '/l', 1]], seen: [url + '/', url + '/l', url + '/done'], attempts: 3 },
    ...extra,
  };
}

test('resumeSite carries the parts it was not asked to do over to the next run', async () => {
  const s = await startServer({
    '/q': page('<p>q@acme.co.nz</p><a href="/done">old</a>'),
    '/l': page('<p>l@acme.co.nz</p><a href="/q">queued</a>'),
  });
  try {
    const prev = savedRow(s.url);
    const r = await resumeSite(prev, { budget: false, limited: true }, NO_BROWSER);
    assert.deepEqual(s.hits, ['/robots.txt', '/l']); // /q stays queued for the budget retry, even though /l links to it
    assert.deepEqual(r.resume?.queued, [[s.url + '/q', 1]]);
    assert.deepEqual(r.resume?.limited, []);
    assert.equal(r.budgetQueued, 1);
    assert.equal(r.rateLimited, undefined);

    const r2 = await resumeSite(r, { budget: true, limited: false }, NO_BROWSER);
    assert.deepEqual(s.hits.slice(2), ['/q']); // /done was fetched by the first crawl
    assert.deepEqual(emailsOf(r2), ['info@acme.co.nz', 'l@acme.co.nz', 'q@acme.co.nz']);
    assert.equal(r2.resume, undefined);
    assert.equal(r2.pages, 4);
  } finally {
    await s.close();
  }
});

test('resumeSite keeps the earlier result when robots.txt now disallows the site', async () => {
  const s = await startServer({ '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /\n' }, '/q': page('<p>q@acme.co.nz</p>') });
  try {
    const prev = savedRow(s.url);
    assert.equal(await resumeSite(prev, { budget: true, limited: true }, NO_BROWSER), prev);
    assert.ok(!s.hits.includes('/q'));
  } finally {
    await s.close();
  }
});

test('resumeSite with the page cap used up fetches nothing and keeps the queue', async () => {
  const s = await startServer({ '/q': page('<p>q@acme.co.nz</p>') });
  try {
    const prev = savedRow(s.url, { rateLimited: undefined });
    prev.resume = { ...prev.resume!, limited: [], attempts: 10 };
    const r = await resumeSite(prev, { budget: true, limited: false }, { ...NO_BROWSER, maxPages: 10 });
    assert.ok(!s.hits.includes('/q'));
    assert.deepEqual(r.resume?.queued, [[s.url + '/q', 1]]);
    assert.equal(r.budgetQueued, 1);
    const r2 = await resumeSite(r, { budget: true, limited: false }, { ...NO_BROWSER, maxPages: 11 });
    assert.deepEqual(emailsOf(r2), ['info@acme.co.nz', 'q@acme.co.nz']);
  } finally {
    await s.close();
  }
});

// ---------- audit 2026-10-13 ----------

test("pages on the site's other origins, and redirect targets, follow their own robots.txt (B1)", async () => {
  // Same hostname, another port: the same site to the crawler, but another origin with its own robots.txt.
  const b = await startServer({
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private\n' },
    '/private': page('<p>private@acme.co.nz</p>'),
    '/ok': page('<p>ok@acme.co.nz</p>'),
  });
  const a = await startServer({
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /secret\n' },
    '/': page(`<a href="mailto:info@acme.co.nz">mail</a><a href="${b.url}/private">P</a><a href="${b.url}/ok">O</a><a href="/go">Go</a><a href="/moved">M</a>`),
    '/go': { redirect: `${b.url}/private` },
    '/moved': { redirect: '/secret' },
    '/secret': page('<p>secret@acme.co.nz</p>'),
  });
  try {
    const r = await scrapeSite(a.url + '/', NO_BROWSER);
    assert.deepEqual(emailsOf(r), ['info@acme.co.nz', 'ok@acme.co.nz']);
    assert.ok(!b.hits.includes('/private'), 'not linked to, and not reached by a redirect either');
    assert.ok(!a.hits.includes('/secret'));
  } finally {
    await a.close();
    await b.close();
  }
});

test('a landing page reached by a redirect into a disallowed path gives robots-disallowed (B1)', async () => {
  const s = await startServer({
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /members\n' },
    '/': { redirect: '/members/home' },
    '/members/home': page('<p>member@acme.co.nz</p>'),
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.error, 'robots-disallowed');
    assert.ok(!s.hits.includes('/members/home'));
  } finally {
    await s.close();
  }
});

const jsPage = (inner: string) => `<html><body><div id="app"></div><script>document.getElementById('app').innerHTML = '${inner}';</script></body></html>`;

test('the browser phase keeps to Crawl-delay too (B2)', { skip: !(await chromiumAvailable()) && 'Chromium not installed' }, async () => {
  const s = await startServer({
    '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nCrawl-delay: 1\n' },
    '/': jsPage('<a href="/a">a</a><a href="/b">b</a>'),
    '/a': jsPage('<p>a@acme.co.nz</p>'),
    '/b': jsPage('<p>b@acme.co.nz</p>'),
  });
  try {
    const r = await scrapeSite(s.url + '/', { browserPages: 5, budgetMs: 60_000 });
    assert.equal(r.usedBrowser, true);
    assert.deepEqual(emailsOf(r), ['a@acme.co.nz', 'b@acme.co.nz']);
    const pages = s.hits.map((h, i) => [h, s.times[i]] as const).filter(([h]) => ['/', '/a', '/b'].includes(h));
    assert.equal(pages.length, 4, JSON.stringify(s.hits)); // "/" over plain HTTP, then "/", "/a", "/b" in the browser
    // Slots open a second apart; the server sees a bit less when the earlier navigation was slow to arrive.
    for (let i = 1; i < pages.length; i++) assert.ok(pages[i][1] - pages[i - 1][1] >= 700, `${pages[i][0]} came ${pages[i][1] - pages[i - 1][1]} ms after ${pages[i - 1][0]}`);
  } finally {
    resetHostPacing();
    await s.close();
  }
});

test('a re-crawl keeps the old row and only adds the new emails it found (B3)', () => {
  const prev: SiteResult = {
    site: 'https://a.nz/', finalUrl: 'https://a.nz/', business: 'Old', pages: 50, usedBrowser: false, budgetQueued: 40,
    emails: [{ email: 'jo@a.nz', name: 'Jo Bloggs', link: 'https://a.nz/team' }, { email: 'old@a.nz', name: null, link: 'https://a.nz/x' }],
  };
  const next: SiteResult = {
    v: 3, site: 'https://a.nz/', finalUrl: 'https://www.a.nz/', business: 'New', pages: 20, usedBrowser: true, rateLimited: 2,
    resume: { queued: [], limited: [['https://www.a.nz/l', 1]], attempts: 20 },
    emails: [{ email: 'old@a.nz', name: 'Ola Dean', link: 'https://www.a.nz/y' }, { email: 'new@a.nz', name: null, link: 'https://www.a.nz/c' }],
  };
  const m = mergeResults(prev, next);
  assert.deepEqual(m.emails.map((e) => [e.email, e.name, e.link]), [
    ['jo@a.nz', 'Jo Bloggs', 'https://a.nz/team'], // not found again: kept
    ['old@a.nz', null, 'https://a.nz/x'], // found again: the old row's version stays
    ['new@a.nz', null, 'https://www.a.nz/c'], // new: added
  ]);
  assert.equal(m.business, 'Old');
  assert.equal(m.finalUrl, 'https://a.nz/');
  assert.equal(m.budgetQueued, undefined, "the old row's log mark doesn't send it back into the next retry");
  assert.equal(m.v, 3);
  assert.equal(m.rateLimited, 2);
  assert.equal(m.usedBrowser, true);
  assert.deepEqual(m.resume, next.resume);

  const dead = mergeResults(prev, { ...next, pages: 0, emails: [], error: 'unreachable' });
  assert.deepEqual(dead.emails, prev.emails);
  assert.equal(dead.pages, 50);
  assert.equal(dead.error, undefined, 'a re-crawl that never reached the site does not mark the kept row as failed');
});

test('untilAborted gives the fallback as soon as the signal aborts', async () => {
  const ctl = new AbortController();
  const slow = new Promise((r) => setTimeout(() => r('late'), 500));
  setTimeout(() => ctl.abort(), 50);
  const t0 = Date.now();
  assert.equal(await untilAborted(slow, ctl.signal, null), null);
  assert.ok(Date.now() - t0 < 400);
  assert.equal(await untilAborted(Promise.resolve('now'), new AbortController().signal, null), 'now');
  await assert.rejects(untilAborted(Promise.reject(new Error('boom')), new AbortController().signal, null), /boom/);
});

test('a scrape aborted while queued behind another site for a server slot stops at once (B5)', async () => {
  const slow: Route = { body: page('<p>slow</p>'), delayMs: 4000 };
  const s = await startServer({
    '/': page('<a href="/a1">1</a><a href="/a2">2</a><a href="/a3">3</a>'),
    '/a1': slow,
    '/a2': slow,
    '/a3': slow,
    '/b': page('<a href="mailto:b@acme.co.nz">mail</a>'),
  });
  const ctlA = new AbortController();
  const ctlB = new AbortController();
  try {
    const a = scrapeSite(s.url + '/', NO_BROWSER, ctlA.signal);
    // wait until site A's three slow pages hold all of the server's slots
    while (s.hits.filter((h) => h.startsWith('/a')).length < 3) await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    setTimeout(() => ctlB.abort(), 300);
    const b = await scrapeSite(s.url + '/b', NO_BROWSER, ctlB.signal);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
    assert.equal(b.error, 'timeout');
    assert.ok(!s.hits.includes('/b'));
    ctlA.abort();
    await a;
  } finally {
    await s.close();
  }
});

test('scrapeSite reports what it has before the browser phase, for the hard timeout to fall back on (B5)', async () => {
  const s = await startServer({ '/': '<html><body><a href="mailto:info@acme.co.nz">mail</a></body></html>' });
  try {
    let partial: SiteResult | undefined;
    const r = await scrapeSite(s.url + '/', { browserPages: 2, budgetMs: 60_000 }, undefined, (p) => { partial = p; });
    assert.ok(partial, 'reported before the browser phase');
    assert.deepEqual(emailsOf(partial), ['info@acme.co.nz']);
    assert.equal(partial.resume?.browser, 'js-rendered'); // so a later --retry-budget-queued can still run it
    assert.equal(r.resume, undefined);
  } finally {
    await s.close();
  }
});

test('a browser context that died with Chromium is replaced (B6)', { skip: !(await chromiumAvailable()) && 'Chromium not installed' }, async () => {
  const s = await startServer({ '/': page('<p>one</p>'), '/two': page('<p>two</p>') });
  const { fetcher, close } = makeBrowserFetcher();
  try {
    assert.match((await fetcher(s.url + '/'))?.html ?? '', /one/);
    await closeBrowser(); // the shared Chromium goes away, and the site's context with it
    assert.match((await fetcher(s.url + '/two'))?.html ?? '', /two/);
  } finally {
    await close();
    await s.close();
  }
});

test('sitemap URLs have their XML escapes undone, and a urlset entry is always a page (B8)', async () => {
  const routes: Record<string, Route> = {
    '/': page('<p>Nothing linked here</p>'),
    '/find?a=1&b=2': page('<p>found@acme.co.nz</p>'),
    '/sitemap-page': page('<p>sitemap@acme.co.nz</p>'),
  };
  const s = await startServer(routes);
  routes['/sitemap.xml'] = { type: 'application/xml', body: `<urlset><url><loc>${s.url}/find?a=1&amp;b=2</loc></url><url><loc>${s.url}/sitemap-page</loc></url></urlset>` };
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.deepEqual(emailsOf(r), ['found@acme.co.nz', 'sitemap@acme.co.nz']);
  } finally {
    await s.close();
  }
});

test('a failed landing page records why, and a domain that does not resolve skips the browser (F1, P1)', async () => {
  const s = await startServer({});
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.equal(r.error, 'unreachable');
    assert.equal(r.errorDetail, 'http-404');
  } finally {
    await s.close();
  }
  const t0 = Date.now();
  const dead = await scrapeSite('https://no-such-host.invalid/', { browserPages: 5, budgetMs: 60_000 });
  assert.equal(dead.error, 'unreachable');
  assert.equal(dead.errorDetail, 'dns');
  assert.equal(dead.usedBrowser, false);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('a site that reaches the page cap saves its queue, and --retry-capped continues it (B7, F4)', async () => {
  const links = Array.from({ length: 6 }, (_, i) => `<a href="/p${i}">p</a>`).join('');
  const routes: Record<string, Route> = { '/': page(`<a href="mailto:info@acme.co.nz">mail</a>${links}`) };
  for (let i = 0; i < 6; i++) routes[`/p${i}`] = page(`<p>p${i}@acme.co.nz</p>`);
  const s = await startServer(routes);
  try {
    const r = await scrapeSite(s.url + '/', { ...NO_BROWSER, maxPages: 3, pageConcurrency: 1 });
    assert.equal(r.pages, 3);
    assert.equal(r.capQueued, 4);
    assert.equal(r.budgetQueued, undefined);
    assert.equal(r.resume?.capped, true);
    assert.equal(r.resume?.queued.length, 4);

    const notThisWay = await resumeSite(r, { budget: true, limited: false }, { ...NO_BROWSER, maxPages: 20 });
    assert.equal(notThisWay.pages, 3, 'a time-budget retry leaves a capped queue alone');
    assert.equal(notThisWay.resume?.capped, true);

    const r2 = await resumeSite(r, { budget: false, limited: false, capped: true }, { ...NO_BROWSER, maxPages: 20 });
    assert.equal(r2.emails.length, 7);
    assert.equal(r2.pages, 7);
    assert.equal(r2.resume, undefined);
    assert.equal(r2.capQueued, undefined);
    for (let i = 0; i < 6; i++) assert.equal(s.hits.filter((h) => h === `/p${i}`).length, 1);
  } finally {
    await s.close();
  }
});

test('frames, iframes and meta refresh lead to pages (F5)', async () => {
  const s = await startServer({
    '/': '<html><frameset><frame src="/menu"><frame src="/main"></frameset></html>',
    '/menu': page('<a href="/contact">Contact</a>'),
    '/main': page('<iframe src="/staff-frame"></iframe><iframe src="https://maps.example.com/embed"></iframe>'),
    '/staff-frame': page('<p>staff@acme.co.nz</p>'),
    '/contact': '<html><head><meta http-equiv="Refresh" content="0; URL=\'/contact-us\'"></head></html>',
    '/contact-us': page('<p>hello@acme.co.nz</p>'),
  });
  try {
    const r = await scrapeSite(s.url + '/', NO_BROWSER);
    assert.deepEqual(emailsOf(r), ['hello@acme.co.nz', 'staff@acme.co.nz']);
  } finally {
    await s.close();
  }
});
