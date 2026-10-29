# TODO

## Pizza website lists for AU and NZ (owner target: AU 5,000–8,100 sites, NZ as many as exist)

Status (2026-10-29): the rules ("Building website lists" in AGENTS.md), `scripts/fetch-osm-places.ts`, `scripts/new-list.ts` and `test/new-list.test.ts` are in place. The lists themselves are not generated yet: the cloud session could not reach a bulk OpenStreetMap source (`overpass-api.de` and mirrors reset or hang, Geofabrik resets, directory sites are blocked or off-limits). The owner runs the fetch locally, where Overpass works.

Existing lists to extend (never edit these): `websites/pizza-au/pizza-shops.au.csv` (513), `pizza-chains.au.csv` (12), `websites/pizza-nz/pizza-shops.nz.csv` (88), `pizza-chains.nz.csv` (8).

Run locally, from the repo root, with Node 22+ and `npm install` done:

1. Fetch candidates (about 10–30 minutes per country, one Overpass query per state or region, retries across mirrors; the `NODE_USE_ENV_PROXY=1` prefix is only needed behind an HTTP proxy):
   ```bash
   npx tsx scripts/fetch-osm-places.ts au ~/pizza-au.candidates.csv
   npx tsx scripts/fetch-osm-places.ts nz ~/pizza-nz.candidates.csv
   ```
2. Dry run, to see the counts and the file name chosen (`pizza-shops-2.au.csv` while only `pizza-shops.au.csv` exists):
   ```bash
   npx tsx scripts/new-list.ts pizza-au pizza-shops au ~/pizza-au.candidates.csv --dry-run
   npx tsx scripts/new-list.ts pizza-nz pizza-shops nz ~/pizza-nz.candidates.csv --dry-run
   ```
3. Write the files by running the same commands without `--dry-run`. Then check that `git status` shows only new `websites/pizza-*/pizza-shops-2.*.csv` files and no edits to the existing ones.
4. Compare the counts with the target. OpenStreetMap only has a website for a fraction of venues, so AU will likely land under 5,000. Further batches become `pizza-shops-3.au.csv`, … Possible sources for the gap: a Google Places API key (search "pizza" by suburb), public directories whose terms allow it, or web search.
5. Optionally paste the candidate CSVs into a Claude session to have it build the files and report the numbers.
6. Scrape the emails only when ready: `npm run scrape -- websites/pizza-au/pizza-shops-2.au.csv` (a deep crawl takes roughly 1–2 hours per 150 sites).
