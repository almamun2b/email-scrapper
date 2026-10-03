import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { page, startServer, type Route } from './helpers/server.js';
import { closeBrowser, scrapeSite } from '../src/crawler.js';

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
    await s.close();
  }
});
