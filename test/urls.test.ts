import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, crawlable, normalizeInput, pageKey, priority, sectionPrefix } from '../src/urls.js';

test('priority() survives malformed percent-encoding (H1)', () => {
  assert.equal(typeof priority(new URL('https://x.co.nz/100%-satisfaction'), 1), 'number');
  assert.equal(typeof priority(new URL('https://x.co.nz/a/%E0%A4%A'), 1), 'number');
});

test('priority() puts contact pages first and listing detail pages last', () => {
  const contact = priority(new URL('https://x.nz/contact-us'), 1);
  const plain = priority(new URL('https://x.nz/random'), 1);
  const detail = priority(new URL('https://x.nz/used-cars/toyota-corolla-123'), 2);
  assert.ok(contact < plain && plain < detail);
});

test('normalizeInput()', () => {
  assert.equal(normalizeInput('example.co.nz'), 'https://example.co.nz/');
  assert.equal(normalizeInput('"http://x.nz/a"'), 'http://x.nz/a');
  assert.equal(normalizeInput('Acme Ltd'), null);
  assert.equal(normalizeInput('ftp://x.nz'), null);
});

test('normalizeInput() repairs "www./" and rejects hosts without a real domain', () => {
  assert.equal(normalizeInput('www./broadbeachaustralia.com'), 'https://www.broadbeachaustralia.com/');
  assert.equal(normalizeInput('https://www./broadbeachaustralia.com'), 'https://www.broadbeachaustralia.com/');
  assert.equal(normalizeInput('https://www./'), null);
  assert.equal(normalizeInput('a..b.com'), null);
  assert.equal(normalizeInput('foo.notatld'), null);
  assert.equal(normalizeInput('http://127.0.0.1:8080/a'), 'http://127.0.0.1:8080/a');
});

test('canonical() drops tracking params, hash, www and trailing slash', () => {
  assert.equal(canonical(new URL('https://www.x.nz/a/?utm_source=f&b=1#top')), 'https://x.nz/a?b=1');
});

test('canonical() keeps the scheme, so URLs saved in earlier caches still match', () => {
  assert.equal(canonical(new URL('http://www.x.nz/a/?b=1')), 'http://x.nz/a?b=1');
  assert.equal(canonical(new URL('https://x.nz/')), 'https://x.nz/');
});

test('pageKey() gives one page one key, however its URL is spelled', () => {
  const same = [
    'https://www.x.nz/contact',
    'http://x.nz/contact/',
    'https://x.nz/contact?utm_source=a&utm_medium=b',
    'https://x.nz/contact?fbclid=1&gclid=2#team',
    'https://x.nz/contact?q=',
    'https://x.nz//contact/index.html',
    'https://X.NZ/contact;jsessionid=ABC123',
    'https://x.nz/contact?PHPSESSID=9',
  ];
  for (const u of same) assert.equal(pageKey(new URL(u)), 'x.nz/contact', u);
  assert.equal(pageKey(new URL('https://x.nz/')), 'x.nz/');
  assert.equal(pageKey(new URL('https://x.nz/index.php')), 'x.nz/');
  assert.equal(pageKey(new URL('https://x.nz/list?b=2&a=1')), pageKey(new URL('http://www.x.nz/list/?a=1&b=2&utm_x=1')));
});

test('pageKey() keeps params that select a different page apart', () => {
  assert.notEqual(pageKey(new URL('https://x.nz/list?page=2')), pageKey(new URL('https://x.nz/list?page=3')));
  assert.notEqual(pageKey(new URL('https://x.nz/list?page=2')), pageKey(new URL('https://x.nz/list')));
  assert.notEqual(pageKey(new URL('https://x.nz/a')), pageKey(new URL('https://x.nz/b')));
  assert.notEqual(pageKey(new URL('https://x.nz/a')), pageKey(new URL('https://y.nz/a')));
});

test('crawlable() keeps same-site HTML pages only', () => {
  assert.ok(crawlable(new URL('https://www.x.nz/team'), 'x.nz'));
  assert.ok(!crawlable(new URL('https://other.nz/team'), 'x.nz'));
  assert.ok(!crawlable(new URL('https://x.nz/brochure.pdf'), 'x.nz'));
  assert.ok(!crawlable(new URL('https://x.nz/wp-login.php'), 'x.nz'));
});

test('sectionPrefix()', () => {
  assert.equal(sectionPrefix(new URL('https://x.nz/'), new URL('https://x.nz/home')), null);
  assert.equal(sectionPrefix(new URL('https://x.nz/'), new URL('https://x.nz/en')), null);
  assert.equal(sectionPrefix(new URL('https://x.nz/'), new URL('https://group.nz/dealers/x')), '/dealers/x');
  assert.equal(sectionPrefix(new URL('https://x.nz/branch'), new URL('https://x.nz/branch')), '/branch');
});
