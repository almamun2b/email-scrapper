import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { decode, httpGet, retryAfterMs } from '../src/http.js';
import type { LookupOptions } from 'node:dns';
import { guardedLookup, isPublicAddress, isPublicHost, setResolver } from '../src/netguard.js';

// No SCRAPER_ALLOW_PRIVATE here: this file checks the guard itself.
delete process.env.SCRAPER_ALLOW_PRIVATE;

test('private, loopback, link-local and metadata addresses are not public (M9)', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});

test('NAT64, 6to4 and documentation ranges are not public either (S3)', () => {
  for (const ip of ['64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', '192.0.2.1', '198.51.100.7', '203.0.113.9']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('guardedLookup connects only to the addresses it checked, and refuses private ones (S2)', async () => {
  const lookup = (host: string, options: LookupOptions) => new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) => {
    guardedLookup(host, options, (err, address, family) => resolve({ err, address, family }));
  });
  let calls = 0;
  setResolver(async (host) => {
    calls++;
    if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }];
    if (host === 'rebind.test') return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
  });
  try {
    assert.deepEqual(await lookup('public.test', {}), { err: null, address: '93.184.216.34', family: 4 });
    assert.deepEqual((await lookup('public.test', { all: true })).address, [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }]);
    assert.deepEqual(await lookup('public.test', { family: 6 }), { err: null, address: '2606:2800:220:1::1', family: 6 });
    assert.equal(calls, 1, 'resolved once, then cached');
    assert.equal((await lookup('rebind.test', {})).err?.code, 'EBLOCKED');
    assert.equal(await isPublicHost('rebind.test'), false);
    assert.equal((await lookup('gone.test', {})).err?.code, 'ENOTFOUND');
    await lookup('gone.test', {});
    assert.equal(calls, 4, 'a failed lookup is not cached');
  } finally {
    setResolver(null);
  }
});

test('hostnames are checked by what they resolve to', async () => {
  assert.equal(await isPublicHost('localhost'), false);
  assert.equal(await isPublicHost('127.0.0.1'), false);
  assert.equal(await isPublicHost('[::1]'), false);
});

test('requests to a local server are refused (M9)', async () => {
  const srv = http.createServer((_req, res) => res.end('<p>secret@intranet.local</p>'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  try {
    assert.equal(await httpGet(`http://127.0.0.1:${port}/`), null);
  } finally {
    srv.close();
  }
});

test('decode() honours the header charset, then <meta>, then UTF-8', () => {
  assert.equal(decode(Buffer.from('café', 'latin1'), 'text/html; charset=iso-8859-1'), 'café');
  assert.equal(decode(Buffer.from('<meta charset="windows-1252">café', 'latin1'), 'text/html'), '<meta charset="windows-1252">café');
  assert.equal(decode(Buffer.from('café', 'utf8'), 'text/html; charset=bogus'), 'café');
});

test('a domain that does not resolve fails fast, without the 3 s retry (L8)', async () => {
  const t0 = Date.now();
  assert.equal(await httpGet('http://no-such-host.invalid/'), null);
  assert.ok(Date.now() - t0 < 2500);
});

test('Retry-After is honoured for the one retry, within 1–30 s', async () => {
  assert.equal(retryAfterMs(null), 3000);
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('0'), 1000);
  assert.equal(retryAfterMs('3600'), 30_000);
  assert.ok(Math.abs(retryAfterMs(new Date(Date.now() + 5000).toUTCString()) - 5000) < 1100);
  assert.equal(retryAfterMs('soon'), 3000);
});

test('a 429 with Retry-After: 1 is retried after about a second', async () => {
  process.env.SCRAPER_ALLOW_PRIVATE = '1';
  let calls = 0;
  const srv = http.createServer((_req, res) => {
    if (calls++ === 0) {
      res.writeHead(429, { 'retry-after': '1' });
      return void res.end();
    }
    res.end('<p>ok</p>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  try {
    const t0 = Date.now();
    const r = await httpGet(`http://127.0.0.1:${port}/`);
    const ms = Date.now() - t0;
    assert.equal(r?.status, 200);
    assert.ok(ms >= 900 && ms < 2500, `${ms} ms`);
  } finally {
    srv.close();
    delete process.env.SCRAPER_ALLOW_PRIVATE;
  }
});
