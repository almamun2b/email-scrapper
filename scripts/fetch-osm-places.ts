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
 * Queries one region at a time (Overpass times out on whole countries), retries with backoff and falls back
 * across public mirrors. Writes `name,website` to <out.csv>; a place without a website tag is skipped, since
 * the scraper needs one. Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1.
 */
import fs from 'node:fs';
import { stringify } from 'csv-stringify/sync';

const MIRRORS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const REGIONS: Record<string, string[]> = {
  au: ['AU-NSW', 'AU-VIC', 'AU-QLD', 'AU-WA', 'AU-SA', 'AU-TAS', 'AU-ACT', 'AU-NT'],
  nz: ['NZ-AUK', 'NZ-BOP', 'NZ-CAN', 'NZ-GIS', 'NZ-HKB', 'NZ-MWT', 'NZ-MBH', 'NZ-NSN', 'NZ-NTL', 'NZ-OTA', 'NZ-STL', 'NZ-TKI', 'NZ-TAS', 'NZ-WKO', 'NZ-WGN', 'NZ-WTC'],
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Element { tags?: Record<string, string> }

async function overpass(query: string): Promise<Element[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const mirror = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'email-scrapper-list-builder/1.0' },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(240_000),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        const json = JSON.parse(text) as { elements?: Element[]; remark?: string };
        if (!json.remark?.includes('runtime error')) return json.elements ?? [];
      }
      console.error(`  ${mirror} → ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.error(`  ${mirror} → ${(err as Error).message}`);
    }
    await sleep(5_000 * 2 ** Math.min(attempt, 4));
  }
  throw new Error('every Overpass mirror failed');
}

const cond = (c: string) => {
  const m = /^([A-Za-z0-9_:.-]+)(~|=)(.+)$/.exec(c.trim());
  if (!m) throw new Error(`bad condition "${c}": use key~regex or key=value`);
  return m[2] === '~' ? `["${m[1]}"~"${m[3]}",i]` : `["${m[1]}"="${m[3]}"]`;
};

function query(region: string, matches: string[]): string {
  const lines = matches.flatMap((m) => {
    const where = m.split('&&').map(cond).join('');
    return ['website', 'contact:website', 'url'].map((k) => `  nwr(area.a)${where}["${k}"];`);
  });
  return `[out:json][timeout:200];\narea["ISO3166-2"="${region}"]->.a;\n(\n${lines.join('\n')}\n);\nout tags;`;
}

const args = process.argv.slice(2);
const matches = args.filter((a) => a.startsWith('--match=')).map((a) => a.slice('--match='.length));
const [cc, out] = args.filter((a) => !a.startsWith('--'));
if (!REGIONS[cc ?? ''] || !out || !matches.length) {
  console.error("usage: fetch-osm-places.ts <au|nz> <out.csv> --match='key~regex' [--match='k=v&&k2~regex' ...]");
  process.exit(2);
}
matches.forEach(cond); // fail on a bad selector before any request
const rows = new Map<string, { name: string; website: string }>();
for (const region of REGIONS[cc]) {
  const elements = await overpass(query(region, matches));
  let n = 0;
  for (const { tags } of elements) {
    if (!tags) continue;
    const website = (tags.website || tags['contact:website'] || tags.url || '').split(';')[0].trim();
    if (!website) continue;
    const key = `${tags.name ?? ''}|${website}`.toLowerCase();
    if (!rows.has(key)) { rows.set(key, { name: tags.name ?? '', website }); n++; }
  }
  console.error(`${region}: ${elements.length} places, ${n} new with a website`);
}
fs.writeFileSync(out, stringify([...rows.values()], { header: true, columns: ['name', 'website'] }));
console.error(`${rows.size} candidates → ${out}`);
