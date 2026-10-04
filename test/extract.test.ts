import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessName, cleanEmail, demoteRolePrefixes, extractFromHtml, nameFromLocal, personName, recheckRow, type Found } from '../src/extract.js';

const byEmail = (html: string) => Object.fromEntries(extractFromHtml(html).map((f) => [f.email, f.name]));

function time(fn: () => void): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

// ---------- baseline behaviour ----------

test('mailto with a person name as link text', () => {
  assert.deepEqual(byEmail('<a href="mailto:jane@x.co.nz">Dr Jane Smith</a>'), { 'jane@x.co.nz': 'Dr Jane Smith' });
});

test('local part gives a name when nothing better exists', () => {
  assert.deepEqual(byEmail('<p>craig.kirkland@lumino.co.nz</p>'), { 'craig.kirkland@lumino.co.nz': 'Craig Kirkland' });
});

test('generic mailbox gets no name', () => {
  assert.deepEqual(byEmail('<p>Email info@clinic.co.nz today</p>'), { 'info@clinic.co.nz': null });
});

test('Cloudflare data-cfemail is decoded', () => {
  // "info@x.nz" XOR 0x42
  const key = 0x42;
  const hex = key.toString(16) + [...'info@x.nz'].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  assert.ok('info@x.nz' in byEmail(`<span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span>`));
});

test('JSON-LD Person email keeps its name', () => {
  const html = `<script type="application/ld+json">{"@type":"Person","name":"Aroha Smith","email":"mailto:aroha@x.nz"}</script>`;
  assert.deepEqual(byEmail(html), { 'aroha@x.nz': 'Aroha Smith' });
});

test('[at] / (dot) obfuscation', () => {
  assert.ok('reception@clinic.co.nz' in byEmail('<p>reception [at] clinic (dot) co (dot) nz</p>'));
  assert.ok('jo@clinic.co.nz' in byEmail('<p>jo@clinic dot co dot nz</p>'));
  assert.ok('jo@clinic.co.nz' in byEmail('<p>Email jo at clinic dot co dot nz</p>'));
});

test('staff card: heading name is tied to the email in the same card', () => {
  const html = `<div class="card"><h3>Sarah Connor</h3><p>sconnor@clinic.co.nz</p></div>
                <div class="card"><h3>Kyle Reese</h3><p>kreese@clinic.co.nz</p></div>`;
  assert.deepEqual(byEmail(html), { 'sconnor@clinic.co.nz': 'Sarah Connor', 'kreese@clinic.co.nz': 'Kyle Reese' });
});

test('junk emails are dropped', () => {
  assert.deepEqual(byEmail('<img src="logo@2x.png"><p>you@example.com noreply@x.nz 5f2b9a1c3d4e5f6a7b8c9d0e1f2a3b4c@sentry.io</p>'), {});
});

// ---------- performance (H2, M6) ----------

test('long alphanumeric run in raw HTML is linear (H2)', () => {
  const html = `<html><body><p>hi</p><script>var x="${'a'.repeat(1_000_000)}"</script></body></html>`;
  assert.ok(time(() => extractFromHtml(html)) < 1500);
});

test('long whitespace runs from empty tags are linear (H2)', () => {
  const html = `<html><body>${'<div><span></span><i></i></div>'.repeat(2_000)}${' '.repeat(500_000)}${'\n\t'.repeat(100_000)}<p>a@b.co.nz</p></body></html>`;
  let found: string[] = [];
  assert.ok(time(() => { found = extractFromHtml(html).map((f) => f.email); }) < 1500);
  assert.deepEqual(found, ['a@b.co.nz']);
});

test('many emails on a big page are fast (M6)', () => {
  const cards = Array.from({ length: 200 }, (_, i) => `<div class="card"><h3>Person ${i}</h3><p>person${i}@clinic.co.nz</p></div>`).join('');
  const html = `<html><body>${cards}${'<div><p>filler text here</p></div>'.repeat(3000)}</body></html>`;
  let n = 0;
  assert.ok(time(() => { n = extractFromHtml(html).length; }) < 1500);
  assert.equal(n, 200);
});

// ---------- TLDs and ROT13 (H5) ----------

test('real gTLDs outside the old whitelist are kept (H5)', () => {
  for (const e of ['bookings@rotorua.travel', 'sales@kiwi.cars', 'info@dealer.auto', 'info@x.tours', 'jo@x.law', 'a@b.global', 'hi@x.media', 'me@email.com']) {
    assert.equal(cleanEmail(e), e);
  }
});

test('invalid TLDs are rejected; ROT13-scrambled addresses are decoded (H5)', () => {
  assert.equal(cleanEmail('media@qldairports.com.ay'), null);
  assert.equal(cleanEmail('vasb@onlpvglzbgbetebhc.pbz.nh'), 'info@baycitymotorgroup.com.au');
  assert.equal(cleanEmail('fcbegfzrq@z3pyvavp.pb.am'), 'sportsmed@m3clinic.co.nz'); // ".pb.am" is ROT13 of ".co.nz"
  assert.equal(cleanEmail('info@hotel.am'), 'info@hotel.am'); // a genuine Armenian address stays
});

test('file names are not emails, and ROT13 never revives them', () => {
  assert.equal(cleanEmail('logo@2x.png'), null);
  assert.equal(cleanEmail('icon@3x.webp'), null);
});

// ---------- names (M1, M2, L2, L3) ----------

test('nameFromLocal only names people (M1)', () => {
  for (const l of ['used.cars', 'parts.department', 'body.shop', 'spare.parts', 'print.room', 'hobart.parts', 'customer.relations',
    'customer.experience', 'trade.res', 'diamondbeach.res', 'travel.carousel', 'soul.events', 'malignant.hyperthermia', 'bec.brisbane']) {
    assert.equal(nameFromLocal(l), null, l);
  }
  for (const [l, n] of [['craig.kirkland', 'Craig Kirkland'], ['julian.park', 'Julian Park'], ['aroha.smith', 'Aroha Smith'], ['priya.patel', 'Priya Patel']]) {
    assert.equal(nameFromLocal(l), n, l);
  }
});

test('a heading only names an email when it matches whole tokens (M2)', () => {
  const near = (name: string, email: string) => byEmail(`<div class="card"><h3>${name}</h3><p>${email}</p></div>`)[email];
  assert.equal(near('Customer Care', 'gmsvcare@gm.com'), null);
  assert.equal(near('Ann Lee', 'annual@x.co.nz'), null);
  assert.equal(near('Sarah Connor', 'sconnor@x.co.nz'), 'Sarah Connor');
  assert.equal(near('Sarah Connor', 'sarahc@x.co.nz'), 'Sarah Connor');
  assert.equal(near('Sarah Connor', 'connor.s@x.co.nz'), 'Sarah Connor');
  assert.equal(near('Dr Amy Wong', 'amy@x.co.nz'), 'Dr Amy Wong');
});

test('personName accepts macrons and accents (L2)', () => {
  assert.equal(personName('Tāne Mahuta'), 'Tāne Mahuta');
  assert.equal(personName('José García'), 'José García');
  assert.equal(personName('Contact Us'), null);
});

test('a name right before a mixed-case email is found (L3)', () => {
  assert.deepEqual(byEmail('<div><p>Kiri Walker <span>Kiri.Walker@Clinic.co.nz</span></p><p>Bob Brown</p></div>'), { 'kiri.walker@clinic.co.nz': 'Kiri Walker' });
});

// ---------- business name (L13) ----------

test('businessName ignores tiny title segments that match the domain (L13)', () => {
  assert.equal(businessName('<title>Home | Auckland Dental | NZ</title>', 'aucklanddentalnz.co.nz'), 'Auckland Dental');
});

// ---------- sources and re-checking cached rows ----------

test('each email records where it was found', () => {
  const html = `<script type="application/ld+json">{"@type":"Organization","email":"a@x.nz"}</script>
    <a href="mailto:b@x.nz">b</a><p>c@x.nz</p><script>var d = "d@x.nz"</script>`;
  assert.deepEqual(Object.fromEntries(extractFromHtml(html).map((f) => [f.email, f.source])), { 'a@x.nz': 'jsonld', 'b@x.nz': 'mailto', 'c@x.nz': 'text', 'd@x.nz': 'raw' });
});

test('recheckRow cleans old cache rows', () => {
  assert.equal(recheckRow({ email: 'media@qldairports.com.ay', name: null }), null);
  assert.deepEqual(recheckRow({ email: 'vasb@onlpvglzbgbetebhc.pbz.nh', name: null }), { email: 'info@baycitymotorgroup.com.au', name: null });
  assert.equal(recheckRow({ email: 'used.cars@x.com.au', name: 'Used Cars' })!.name, null); // old local-part name
  assert.equal(recheckRow({ email: 'gmsvcare@gm.com', name: 'Customer Care' })!.name, null); // all department words
  assert.equal(recheckRow({ email: 'aroha@x.nz', name: 'Aroha Smith' })!.name, 'Aroha Smith'); // scraped name kept
  assert.equal(recheckRow({ email: 'craig.kirkland@lumino.co.nz', name: 'Craig Kirkland' })!.name, 'Craig Kirkland');
});

test('recheckRow leaves fresh results unchanged', () => {
  const html = '<a href="mailto:jane@x.co.nz">Dr Jane Smith</a><p>craig.kirkland@lumino.co.nz info@x.nz</p>';
  for (const f of extractFromHtml(html)) assert.deepEqual(recheckRow(f), f);
});

test('demoteRolePrefixes clears per-branch role mailboxes', () => {
  const cities = ['artarmon', 'blacktown', 'brighton', 'cairns', 'sydney'];
  const rows: Found[] = cities.map((c) => ({ email: `mark.${c}@byd.com.au`, name: `Mark ${c[0].toUpperCase()}${c.slice(1)}` }));
  rows.push({ email: 'rachel.lund@otago.ac.nz', name: 'Rachel Lund' }, { email: 'rachel.elliot@otago.ac.nz', name: 'Rachel Elliot' });
  demoteRolePrefixes(rows);
  assert.deepEqual(rows.map((r) => r.name), [null, null, null, null, null, 'Rachel Lund', 'Rachel Elliot']);
});

test('stop words match whole parts, not substrings', () => {
  assert.equal(nameFromLocal('caroline.ward'), 'Caroline Ward');
  assert.equal(nameFromLocal('dean.williams'), 'Dean Williams');
  assert.equal(nameFromLocal('tina.unitt'), 'Tina Unitt'); // contains the stop word "unit"
  assert.equal(nameFromLocal('mark.helpline'), null);
  assert.equal(nameFromLocal('sarah.recruitment'), null);
});

test('a JSON string escape before an address is not part of it', () => {
  assert.ok('david.xuereb@x.com.au' in byEmail('<script>var s = "Contact:\\ndavid.xuereb@x.com.au";</script>'));
});

test('a page-confirmed name survives re-checking even with an unlisted first name', () => {
  const [row] = extractFromHtml('<div><h3>Perryne Brasko</h3><p>perryne.brasko@x.com.au</p></div><div><h3>Other Person</h3></div>');
  assert.deepEqual(row, { email: 'perryne.brasko@x.com.au', name: 'Perryne Brasko', source: 'text', nameFrom: 'page' });
  assert.equal(recheckRow(row)!.name, 'Perryne Brasko');
});

test('old rows: names the old local-part rule could not produce are treated as page names', () => {
  assert.equal(recheckRow({ email: 'craig.hammermeister@x.com.au', name: 'Craig Hammermeister' })!.name, 'Craig Hammermeister');
  assert.equal(recheckRow({ email: 'rex.xu@x.com.au', name: 'Rex Xu' })!.name, 'Rex Xu');
});
