# Finding websites by web search (for places that have no website in the map data)

Used for the pizza lists on 2026-10-29. Map sources (OpenStreetMap, Overture Maps) list many businesses without a website; the scraper needs a website, so those rows are looked up by web search. Run this after the map sources are exhausted (see [TODO.md](TODO.md), "Generate a website list for any sector").

## Inputs

- Overture Maps places for the sector with no `websites` value. The query is `scripts/overture-places.py` with `websites[1] IS NOT NULL` removed (and `taxonomy.alternates` added if wanted). Keep `name`, `locality`, `region`, `taxonomy.primary`. Drop `operating_status = 'closed'`.
- Remove duplicate (name, locality) pairs, then split into batches of about 50 rows (`name,locality,region,category`).
- Leave out national chains (Pizza Hut, Domino's, Hell Pizza, Pizza Capers, ...): every store maps to a chain site that is already in the `*-chains` lists, so the search finds nothing new.

## Search

1. One WebSearch per row, query `"<name>" <locality> <sector word>` (for example `"Woodpeckers Woodfired Pizzeria" Perth pizza`).
2. Keep the result only if it is the business's **own website** and the results tie that URL to this business in this locality. Take the homepage of the business's domain.
3. Do not accept:
   - social pages (facebook, instagram, tiktok, linktr.ee), google/share.google/g.page/business.site, free wixsite or Google Sites pages
   - delivery and ordering platforms (ubereats, menulog, doordash, deliveroo, nextorder, flipdish, tuckerfox, ordermate ...)
   - directories and reviews (tripadvisor, yelp, yellowpages, localsearch, zomato, mapquest, zmenu, agfg ...)
   - businesses that are not the sector (pizza-oven sellers, bakeries that mention pizza, parks, rentals) and closed businesses
4. Never guess or construct a URL. A domain that is only named in a directory's text and never returned as a result is weak: record it only if it clearly matches the name and suburb, and list it as weak in the report.
5. Write found rows to `name,website` per batch; append the searched names to a log file after each group so a stopped run can be resumed.

## Running it

- Use background subagents (general-purpose, `sonnet`), one batch each, 3 to 4 searches in parallel at a time. More at once gives `too_many_requests`.
- **Limit: 200 WebSearch calls per turn, shared by every subagent.** In practice one turn is about 4 subagents x 48 rows. Do not try to raise it; run the next batch in the next turn. A batch that hits the limit reports how far it got, and the rest are "not searched", not "no site".
- Yield on pizza: about 15 to 18 % of searches give an own website; the rest give only Facebook, ordering apps or directories. Roughly 190 searches add 30 to 35 sites.

## Adding the results

1. Merge the batch outputs into one `name,website` file and run `npx tsx scripts/new-list.ts <category> <list> <cc> <file> --dry-run`, then without `--dry-run` (or with `--append`). It drops sites already in the category, in-file duplicates, ordering platforms, social pages and `.edu` sites.
2. Per AGENTS.md, new sites go into the single unscraped numbered file of the list (`pizza-shops-2.au.csv`), not a new number, until that file has been scraped.
3. Spot-check about 20 random rows by opening the site. Report the new count, the weak matches and how many places are still unsearched.

## Sources that are not used

Paid or terms-restricted data (ByteScraper, restaurantslistshq, POIData) and scraping Yellow Pages, Yelp or TripAdvisor.
