/**
 * Candidate pizza places with a website from OpenStreetMap (Overpass API), for scripts/new-list.ts.
 *
 *   npx tsx scripts/fetch-osm-places.ts <au|nz> <out.csv> [--topic=pizza]
 *
 * Takes food venues whose cuisine or name says pizza and that carry a website tag. Queries one region at a time
 * (Overpass times out on whole countries), retries with backoff and falls back across public mirrors. Writes
 * `name,website` to <out.csv>; a venue without a website tag is skipped, since the scraper needs one.
 */
import fs from 'node:fs';
import { stringify } from 'csv-stringify/sync';

const MIRRORS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const REGIONS: Record<string, string[]> = {
  au: ['AU-NSW', 'AU-VIC', 'AU-QLD', 'AU-WA', 'AU-SA', 'AU-TAS', 'AU-ACT', 'AU-NT'],
  nz: ['NZ-AUK', 'NZ-BOP', 'NZ-CAN', 'NZ-GIS', 'NZ-HKB', 'NZ-MWT', 'NZ-MBH', 'NZ-NSN', 'NZ-NTL', 'NZ-OTA', 'NZ-STL', 'NZ-TKI', 'NZ-TAS', 'NZ-WKO', 'NZ-WGN', 'NZ-WTC'],
};
const FOOD = 'restaurant|fast_food|cafe|bar|pub|food_court|ice_cream|biergarten';
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

const query = (region: string) => `[out:json][timeout:200];
area["ISO3166-2"="${region}"]->.a;
(
  nwr(area.a)["cuisine"~"pizza",i]["website"];
  nwr(area.a)["cuisine"~"pizza",i]["contact:website"];
  nwr(area.a)["cuisine"~"pizza",i]["url"];
  nwr(area.a)["amenity"~"^(${FOOD})$"]["name"~"pizz",i]["website"];
  nwr(area.a)["amenity"~"^(${FOOD})$"]["name"~"pizz",i]["contact:website"];
);
out tags;`;

const [cc, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!REGIONS[cc ?? ''] || !out) {
  console.error('usage: fetch-osm-places.ts <au|nz> <out.csv>');
  process.exit(2);
}
const rows = new Map<string, { name: string; website: string }>();
for (const region of REGIONS[cc]) {
  const elements = await overpass(query(region));
  let n = 0;
  for (const { tags } of elements) {
    if (!tags) continue;
    const website = (tags.website || tags['contact:website'] || tags.url || '').split(';')[0].trim();
    if (!website) continue;
    const key = `${tags.name ?? ''}|${website}`.toLowerCase();
    if (!rows.has(key)) { rows.set(key, { name: tags.name ?? '', website }); n++; }
  }
  console.error(`${region}: ${elements.length} venues, ${n} new with a website`);
}
fs.writeFileSync(out, stringify([...rows.values()], { header: true, columns: ['name', 'website'] }));
console.error(`${rows.size} candidates → ${out}`);
