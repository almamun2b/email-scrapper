# TODO

## Set up the project locally (once)

There is no config file or `.env`; the setup is installing dependencies. You need Node 22+ and git.

```bash
git clone https://github.com/almamun2b/email-scrapper.git
cd email-scrapper
git checkout scrapping-websites
```

```bash
npm install
```

```bash
npx playwright install chromium
```

Check that it works:

```bash
npm run typecheck
```

```bash
npm test
```

- `npx playwright install chromium` is only needed for email scraping (the browser fallback), not for generating lists.
- The `websites/` input lists are tracked in git, so they come with the clone. `results/` is git-ignored and starts empty on a new machine.
- If Chromium fails to start with a sandbox error on Linux, see "Headless browser sandbox" in README.md (`SCRAPER_NO_SANDBOX=1` is the opt-out).
- Every crawl option is a command-line flag: `npm run scrape -- --help`.
- Git: commit with your own git config. Claude adds no `Co-Authored-By` or session lines (see CLAUDE.md "Git commits").

## Generate a website list for any sector, then scrape its emails

The tool is sector-agnostic: any list of websites (healthcare, dealers, trades, retail, hospitality, ...) in AU, NZ or elsewhere. Lists live in `websites/<topic>-<au|nz>/`; the rules are in AGENTS.md "Building website lists". An existing list is never edited: more sites for the same topic go into `<list>-2.<cc>.csv`; one new file per list per session (later batches of the session use `new-list.ts --append`), the next session uses `-3`.

1. Fetch candidates from OpenStreetMap. Describe the sector with one or more `--match` selectors (`key~regex` or `key=value`, conditions joined by `&&`); a place with a website tag that fits any selector is kept. About 10–30 minutes per country; add `NODE_USE_ENV_PROXY=1` only behind an HTTP proxy:
   ```bash
   npx tsx scripts/fetch-osm-places.ts au ~/candidates.au.csv --match='amenity=dentist' --match='healthcare=dentist'
   ```
   Selector examples:
   | Sector | Selectors |
   |---|---|
   | Pizza | `--match='cuisine~pizza' --match='name~pizz&&amenity~restaurant\|fast_food\|cafe'` |
   | Dentists | `--match='amenity=dentist' --match='healthcare=dentist'` |
   | Car dealers | `--match='shop=car'` |
   | Gyms and martial arts | `--match='leisure=fitness_centre' --match='sport~martial\|karate\|judo'` |
   | Any other | find the OpenStreetMap tag on https://taginfo.openstreetmap.org and use it |
2. Dry run, to see the counts and the file name chosen. Arguments: `<category folder> <list name> <au|nz> <candidates.csv>`:
   ```bash
   npx tsx scripts/new-list.ts dentists-au dentists au ~/candidates.au.csv --dry-run
   ```
3. Write the file by running the same command without `--dry-run`. `git status` should show only new `websites/...-2.<cc>.csv`-style files and no edits to existing ones.
4. Compare the count with the owner's target for that sector. OpenStreetMap only has a website for a fraction of places, so a large target may not be reached; the shortfall is reported, not padded. Further batches in the same session are added with `--append`; a later session starts `-3`. Other sources for gaps: a Google Places API key (search by suburb), public directories whose terms allow it, web search.
5. Optionally paste the candidate CSVs into a Claude session to have it build the files and report the numbers.
6. Scrape the emails only when ready: `npm run scrape -- websites/<category>/<list>.<cc>.csv` (a deep crawl takes roughly 1–2 hours per 150 sites).

## Open items

- **Pizza, AU and NZ: lists generated 2026-10-29, AU still short of the target.** Owner target: AU 5,000–8,100 sites, NZ as many as exist. Sites now in the categories (all files, `pizza-shops*` + `pizza-chains*`):

  | | shops | chains | total | target |
  |---|---|---|---|---|
  | AU (`websites/pizza-au/`) | 3,689 | 863 | 4,552 | 5,000–8,100 (about 450 short of the low end) |
  | NZ (`websites/pizza-nz/`) | 372 | 222 | 594 | as many as exist |

  The original files were not edited; added are `pizza-shops-2` and `pizza-chains-2` for each country (OpenStreetMap and Overture Maps batches merged into the one file for this session). Chain rows are mostly store-locator pages (Pizza Hut and Domino's about 550 AU pages). They are separate sites to the scraper, but their emails are the head office's. Email scraping has not been run on any new list.
  - **Overpass was unusable** from the owner's network (every mirror timed out), so OpenStreetMap came from a Geofabrik extract (`scripts/pbf-places.py`, needs `pip install osmium`). It added only 179 AU and 22 NZ new shops, because the old lists already held most of it. The tiled Overpass fetcher (`scripts/fetch-osm-places.ts`) works when Overpass is reachable.
  - **Overture Maps** (`scripts/overture-places.py`, needs `pip install duckdb`) gave the bulk: about 5,900 AU and 800 NZ pizza places with a website. `scripts/split-chains.py` moved chain rows into the chains lists. Ordering and directory platforms (nextorder, ozfoodhunter, posbosshq, ...) and `.edu.au` sites are dropped by `new-list.ts`.
  - **To close the AU gap:** places with no website in Overture/OSM are unusable for the scraper. Options: a Google Places API key (search by suburb), web search by suburb, or directories whose terms allow it. The next session's batch becomes `pizza-shops-3.au.csv` (or `--append` if done in the same session as `-2`).
  - **Next:** scrape the emails (`npm run scrape -- websites/pizza-au/pizza-shops-2.au.csv`, then the others); a deep crawl takes roughly 1–2 hours per 150 sites, so the 2,993-site AU file is a multi-day run. Chains lists are low value (head-office emails only), so scrape them last or skip them.
