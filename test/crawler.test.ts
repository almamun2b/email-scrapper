import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { page, startServer, type Route } from './helpers/server.js';
import { closeBrowser, resumeSite, scrapeSite, type SiteResult } from '../src/crawler.js';
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

test('robots.txt answering 5xx means keep out (RFC 9309)', async () => {
  const s = await startServer({
    '/robots.txt': { status: 500, body: 'oops' },
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
