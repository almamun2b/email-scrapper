import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleMessage } from '../src/logger.js';

test('console lines name the site and URL that the hidden fields hold', () => {
  assert.equal(
    consoleMessage({ msg: 'headless browser failed on this site', site: 'https://www.aolimo.com.au/' }),
    '[aolimo.com.au] headless browser failed on this site',
  );
  assert.equal(
    consoleMessage({ msg: 'request failed', site: 'https://x.nz/', url: 'https://x.nz/contact' }),
    '[x.nz] request failed — https://x.nz/contact',
  );
});

test('nothing is repeated that the message already says', () => {
  assert.equal(consoleMessage({ msg: '[3/9] x.nz — 2 emails', site: 'https://x.nz/' }), '[3/9] x.nz — 2 emails');
  assert.equal(
    consoleMessage({ msg: 'x.nz is rate-limiting requests; skipped /contact', site: 'https://x.nz/', url: 'https://x.nz/contact' }),
    'x.nz is rate-limiting requests; skipped /contact',
  );
  assert.equal(consoleMessage({ msg: 'run started' }), 'run started');
});

test('only the first line of an error is appended, and assertion noise is left out', () => {
  assert.equal(consoleMessage({ msg: 'failed', err: { message: 'browserType.launch: boom\n╔═══ banner ═══╗' } }), 'failed: browserType.launch: boom');
  assert.equal(consoleMessage({ msg: 'closed mid-response', err: { type: 'AssertionError', message: 'false == true' } }), 'closed mid-response');
});
