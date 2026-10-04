import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, crawlable, normalizeInput, priority, sectionPrefix } from '../src/urls.js';

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
