/**
 * Candidate businesses of any sector, with a website, from OpenStreetMap (Overpass API), for scripts/new-list.ts.
 *
 *   npx tsx scripts/fetch-osm-places.ts <au|nz> <out.csv> --match=<selector> [--match=<selector> ...]
 *
 * Each --match is one way to qualify: `key~regex` (case-insensitive regex on a tag) or `key=value`, with several
 * conditions joined by `&&`. A place qualifies when any --match fits and it has a website tag.
 *
 *   pizza        --match='cuisine~pizza' --match='name~pizz&&amenity~restaurant|fast_food|cafe|bar|pub'
 *   dentists     --match='amenity=dentist' --match='healthcare=dentist'
 *   car dealers  --match='shop=car'
 *   gyms         --match='leisure=fitness_centre' --match='sport~martial|karate|judo'
 *
 * Queries the country in bounding-box tiles, one request at a time (the public servers refuse parallel load and
 * time out on whole states). A tile that fails is split into four and retried, down to MIN_SPAN degrees; tiles
 * that still fail are listed at the end. Finished tiles are saved to `<out.csv>.tiles.jsonl`, so running the
 * same command again resumes. Writes `name,website` to <out.csv>; a place without a website tag is skipped,
 * since the scraper needs one. Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1.
 */
import fs from 'node:fs';
import { stringify } from 'csv-stringify/sync';

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
/** [south, west, north, east] */
type Box = [number, number, number, number];
const COUNTRIES: Record<string, Box[]> = {
  au: [[-44, 112, -9, 154.5]],
  nz: [[-47.5, 166, -34, 178.8]],
};
const START_SPAN = 6; // degrees
const MIN_SPAN = 0.25;
const TRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Element { tags?: Record<string, string> }
interface Place { name: string; website: string }

const cond = (c: string) => {
  const m = /^([A-Za-z0-9_:.-]+)(~|=)(.+)$/.exec(c.trim());
  if (!m) throw new Error(`bad condition "${c}": use key~regex or key=value`);
  return m[2] === '~' ? `["${m[1]}"~"${m[3]}",i]` : `["${m[1]}"="${m[3]}"]`;
};

function query(box: Box, matches: string[]): string {
  const bbox = `(${box.join(',')})`;
  const lines = matches.flatMap((m) => {
    const where = m.split('&&').map(cond).join('');
    return ['website', 'contact:website', 'url'].map((k) => `  nwr${where}["${k}"]${bbox};`);
  });
  return `[out:json][timeout:90];\n(\n${lines.join('\n')}\n);\nout tags;`;
}

/** Elements of one tile, or null when every try failed (the caller splits the tile). */
async function overpass(q: string): Promise<Element[] | null> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const mirror = MIRRORS[attempt % MIRRORS.length];
    let wait = 3_000;
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'email-scrapper-list-builder/1.0' },
        body: new URLSearchParams({ data: q }),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        const json = JSON.parse(text) as { elements?: Element[]; remark?: string };
        if (!json.remark?.includes('runtime error')) return json.elements ?? [];
      }
      if (res.status === 429) wait = 20_000; // no free slot: back off rather than split
      console.error(`  ${mirror} → ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.error(`  ${mirror} → ${(err as Error).message}`);
    }
    await sleep(wait);
  }
  return null;
}

const split = ([s, w, n, e]: Box): Box[] => {
  const ms = (s + n) / 2, mw = (w + e) / 2;
  return [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]];
};
const tiles = ([s, w, n, e]: Box): Box[] => {
  const out: Box[] = [];
  for (let la = s; la < n; la += START_SPAN) for (let lo = w; lo < e; lo += START_SPAN) out.push([la, lo, Math.min(la + START_SPAN, n), Math.min(lo + START_SPAN, e)]);
  return out;
};

const args = process.argv.slice(2);
const matches = args.filter((a) => a.startsWith('--match=')).map((a) => a.slice('--match='.length));
const [cc, out] = args.filter((a) => !a.startsWith('--'));
if (!COUNTRIES[cc ?? ''] || !out || !matches.length) {
  console.error("usage: fetch-osm-places.ts <au|nz> <out.csv> --match='key~regex' [--match='k=v&&k2~regex' ...]");
  process.exit(2);
}
matches.forEach(cond); // fail on a bad selector before any request

const progressFile = `${out}.tiles.jsonl`;
const places = new Map<string, Place>();
const done = new Set<string>();
for (const line of fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8').split('\n') : []) {
  if (!line) continue;
  try {
    const r = JSON.parse(line) as { tile: string; places: Place[] };
    done.add(r.tile);
    for (const p of r.places) places.set(`${p.name}|${p.website}`.toLowerCase(), p);
  } catch { /* a half-written last line from an interrupted run */ }
}

const failed: Box[] = [];
async function run(box: Box): Promise<void> {
  const id = box.join(',');
  if (done.has(id)) return;
  const elements = await overpass(query(box, matches));
  if (!elements) {
    if (box[2] - box[0] > MIN_SPAN) for (const t of split(box)) await run(t);
    else { failed.push(box); console.error(`tile ${id} failed at the minimum size`); }
    return;
  }
  const found: Place[] = [];
  for (const { tags } of elements) {
    if (!tags) continue;
    const website = (tags.website || tags['contact:website'] || tags.url || '').split(';')[0].trim();
    if (!website) continue;
    const key = `${tags.name ?? ''}|${website}`.toLowerCase();
    if (!places.has(key)) { const p = { name: tags.name ?? '', website }; places.set(key, p); found.push(p); }
  }
  fs.appendFileSync(progressFile, JSON.stringify({ tile: id, places: found }) + '\n');
  done.add(id);
  if (elements.length) console.error(`tile ${id}: ${elements.length} places, ${found.length} new with a website (total ${places.size})`);
}

for (const box of COUNTRIES[cc].flatMap(tiles)) await run(box);
fs.writeFileSync(out, stringify([...places.values()], { header: true, columns: ['name', 'website'] }));
console.error(`${places.size} candidates → ${out}${failed.length ? `; ${failed.length} tiles failed (run again to retry): ${failed.map((b) => b.join(',')).join(' | ')}` : ''}`);
