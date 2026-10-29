# AGENTS.md

Operating guide for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. For what the tool does, see [README.md](README.md). For how it's built, see [ARCHITECTURE.md](ARCHITECTURE.md).

## The recurring job

The owner regularly drops a CSV of websites into `websites/<category>/` (`healthcare`, `martial-arts`, `dealers`, or a new folder for a new kind of list) and asks the agent to "extract emails" from it. The agent runs the scraper and reports results. Output goes to `results/<category>/emails/<same-file-name>.csv` with columns **`name,email,website,link`**, and a summary is appended to `results/<category>/logs/<same-file-name>.log`. Each category folder under `results/` holds the output CSVs in its `emails/` subfolder (with the `--unique` lists in `emails/unique/`), plus `.cache/` and `logs/`. A CSV placed directly in `websites/` has no category and gets its own folder, `results/<file-name>/`; if the owner hasn't said which category a new list belongs to, ask, or put it in a new category folder named after what it is.

Standard procedure:

1. Check the input: `head -5 websites/<category>/<file>.csv` and `wc -l websites/<category>/<file>.csv`. Any header named `website`/`url`/`domain`/`site`/`websites`/`link` works; otherwise the most URL-like column is used. A `name` column (or `business name`, `church name`, …) becomes the row name when no person or department name is found. `npm run scrape -- <file> --dry-run` shows what a command would do without running it.
2. Run it in the background, because it takes about 1–2 hours per 150 sites with the default deep crawl (30–60 minutes with `--quick`):
   ```bash
   nohup npm run scrape -- websites/<category>/<file>.csv > <scratch>/run.log 2>&1 &
   ```
   Plain `npm run scrape` processes every input file that has no output yet.
3. Watch progress in the log. Each site prints `[n/N] host — X emails, Y pages …`. The run for a file ends with a `=>` line and the summary block.
4. If the run says a file is "in use by another run", another scrape holds `results/<category>/.cache/<file>.lock`. Don't delete the lock; find and wait for that PID.
5. Report per-file totals from the summary: websites with emails, websites with no emails, failed websites grouped by reason and detail (`unreachable=12 (dns=8, http-403=4)`; `browser-error` means Chromium crashed on that site; `robots-unavailable` is a robots.txt server error, retried by `--retry-failed`), unique emails, the name breakdown. Mention noteworthy failures. Check `logs/error-<date>.log` (JSON lines, `npx pino-pretty < file` to read) and report any errors from the run (match its `runId`). For a site that failed for unclear reasons, re-run it alone with `--log-level=debug`.
6. Offer the retry that matches what the summary shows. They are separate flags, can be combined, reuse the existing cache and keep everything else:
   - `Failures` (many `unreachable`/`timeout`, often transient): `--retry-failed` crawls those sites again from the start.
   - `Limited` (servers answered 429/503): `--retry-rate-limited` fetches only the refused pages (and new links on them), with the automatic per-server slow-down. If it stays large, add `--host-concurrency=1` or `--concurrency=6`.
   - `Out of time` (sites ran out of budget with pages queued): `--retry-budget-queued=MIN` continues them from the saved queue without refetching anything. Suggest a budget that fits: sites with `Crawl-delay: 10` get only about 6 pages a minute.
   - `Capped` (sites reached `--max-pages` with pages queued): only if the owner wants deeper coverage, `--retry-capped --max-pages=N` (N above the cap they stopped at) continues them. Contact-like pages are already fetched first, so this is rarely needed.

   Sites from runs before this feature have no saved queue. `npx tsx scripts/mark-budget-from-logs.ts` shows which ones the logs say ran out of time; with `--write` (ask the owner first, and only when no run is working on those files) it marks them so `--retry-budget-queued` re-crawls them. A re-crawled site keeps its earlier row exactly as it was; only new emails are added.

## Commands

| Task | Command |
|---|---|
| Install | `npm install && npx playwright install chromium` |
| Type-check | `npm run typecheck` |
| Tests (no network needed) | `npm test` |
| See what the current rules would change in existing outputs (writes nothing) | `npx tsx scripts/recheck-cache.ts` |
| Scrape new input files | `npm run scrape` |
| Scrape specific files (always re-scrapes) | `npm run scrape -- websites/dealers/a.csv` |
| Re-scrape everything | `npm run scrape -- --force` |
| Scrape only the sites added to a list that was already scraped (cache kept) | `npm run scrape -- --new-only websites/dealers/a.csv` |
| Re-scrape only failed sites (no emails) | `npm run scrape -- --retry-failed` |
| Fetch the pages servers refused with 429/503 | `npm run scrape -- --retry-rate-limited` |
| Continue sites that ran out of time budget | `npm run scrape -- --retry-budget-queued=60` |
| Continue sites that reached the page cap | `npm run scrape -- --retry-capped --max-pages=800` |
| Ask again about stored pages older than N days (default 30); with no number, about every stored page once | `--revalidate=N` / `--revalidate` |
| Show what a command would do, without running it | add `--dry-run` |
| Drop emails whose domain can't receive mail (DNS only) | add `--check-mx` (e.g. with `--summary-only`) |
| List every option | `npm run scrape -- --help` |
| Mark sites that ran out of time before the queue was saved (dry run; `--write` to apply) | `npx tsx scripts/mark-budget-from-logs.ts` |
| Rebuild CSVs and logs from cache with the current rules, no network | `npm run scrape -- --summary-only` |
| One list per category with each email once, no network (`results/<category>/emails/unique/<category>.csv`) | `npm run scrape -- --unique` |
| Same for only some files (`results/dealers/emails/unique/au.csv`) | `npm run scrape -- --unique websites/dealers/au.*.csv` |
| Also write only the emails whose domain ends with / doesn't end with some suffixes (`emails/filtered/<name>.<filter>.csv`; with `--unique`, `emails/unique/<label>.<filter>.csv`) | add `--include-suffix=.com,.au` / `--exclude-suffix=.gov,.edu` (quote the `[..]` form) |
| Verbose diagnostics in `logs/` | `npm run scrape -- websites/dealers/a.csv --log-level=debug` |
| Lighter, faster crawl (150 pages, 10 min/site) | `npm run scrape -- --quick` |
| Tune limits (any combination) | `--max-pages=N --browser-pages=N --max-depth=N --budget=MIN --concurrency=N --page-concurrency=N --host-concurrency=N` |

Deep crawl is the default: no page cap (`--max-pages=0`), 60 browser pages, unlimited depth (`--max-depth=0`), 20 min per site. Use it for dealer, tourism and other large-site lists. Use `--quick` only when the owner wants speed over coverage. All flags are documented in README.md under "Crawl options".

Run `npm run typecheck` and `npm test` after every change, and add a test for each fix in `test/` (crawler tests use the local server in `test/helpers/server.ts`). For a quick look at one real site or snippet, use a throwaway `.mts` script (ESM, top-level `await` allowed) run with `npx tsx`, and put it outside the repo:

```ts
// scratch/check.mts
import { scrapeSite, closeBrowser } from '/abs/path/to/src/crawler.ts';
import { extractFromHtml } from '/abs/path/to/src/extract.ts';
console.log(extractFromHtml('<a href="mailto:jane@x.co.nz">Dr Jane Smith</a>'));
const r = await scrapeSite('https://lumino.co.nz/');
console.log(r.error, r.pages, r.emails);
await closeBrowser();
```

Regression baseline: `https://lumino.co.nz/` gives 11 emails with the deep defaults, which have no page cap (it was 6 when the cap was 400; 3 with `QUICK_OPTIONS`), including `craig.kirkland@lumino.co.nz` named "Craig Kirkland". `https://adhb.health.nz/` gives `robots-disallowed`.

After changing anything in `extract.ts`, run `npx tsx scripts/recheck-cache.ts` and review the dropped emails and removed or changed names against the 13k cached rows. Look for lost real people as well as junk that got through.

For an end-to-end check, write a 2–4 row sample CSV outside `websites/` and run `npm run scrape -- <path>`. A sample outside `websites/` gets its own `results/<sample>/` folder. Then **delete** that whole folder (output, logs, `.cache/` with its `.jsonl`, plus any `.inprogress`, `.lock` or rotated `<sample>.<timestamp>.jsonl`, and `unique/`). This is the only cache cleanup allowed.

## Rules the owner has set

- **Output columns are exactly `name,email,website,link`.** `website` is the input URL and `link` is the page the email was found on. `name` falls back in this order: person name, then department page title, then the input's own name column, then the scraped business name (owner decision 2026-10-13).
- **Each email is credited to the site that owns it** (its domain), else where it wasn't only in raw HTML, else the first site. There is no `shared/` file: every email stays in its list's own CSV (owner decision 2026-10-16).
- **A re-crawled site keeps its old row; only new emails are added** (owner decision 2026-10-13).
- **Never delete any `results/<category>/.cache/`.** The owner keeps it for future improvements. A fresh re-scrape renames the old cache to `<name>.<timestamp>.jsonl`; nothing deletes it. The same goes for `results/<category>/.cache/.pages`, the pages every list of the category has fetched (a page is never scraped twice; stored pages are revalidated after 30 days, `--revalidate=N` changes that). It is only appended to; never delete or edit it, and never delete `.pages.lock` while its PID is alive.
- **Don't re-scrape existing outputs unless asked.** Code changes apply to future runs; the owner decides when to re-run. That includes `--summary-only`: it rebuilds existing CSVs with the current rules, so only run it when asked.
- **Email filters apply to outputs only** (owner decision 2026-10-23). `--include-suffix` / `--exclude-suffix` never change what is scraped or cached and never change the normal CSV; they add a file named after the filter in `emails/filtered/` (`emails/unique/` for `--unique`). A suffix matches at a dot (`.gov` does not match `x.gov.au`); include and exclude combine. A list that isn't being scraped is filtered from its cache. There is deliberately no country filter. Don't filter inside the crawler or `extract.ts`.
- **Respect robots.txt**, including on the host reached after a redirect, on every redirect hop, on the site's `www.`/`http:` variants (each origin by its own robots.txt), and in the browser fallback, Crawl-delay included. Don't add bypasses.
- **Each summary is appended** to `results/<category>/logs/<name>.log` after every run. Keep that behaviour for any new mode.
- `websites/`, `results/` and `logs` are git-ignored data. Never commit them.
- **No agent attribution in git** (owner decision 2026-10-29). Every commit, amend, rebase, merge, pull, push, tag and PR is made as the owner, never as Claude or any agent. No `Co-Authored-By`, `Claude-Session` or "Generated with …" lines in commit messages or PR bodies, and never set or override the git identity (`git config user.*`, `-c user.name`, `--author`): commit with the owner's active git config. If the active identity is `Claude <noreply@anthropic.com>` (cloud or sandbox sessions), don't commit; tell the owner.

## Building website lists

When the owner asks to find, search or generate websites for a category (any sector, e.g. "all dentists in NZ" or "all pizza shops in AU and NZ"):

- **Where and what:** `websites/<topic>-<au|nz>/<list>.<au|nz>.csv` with header `name,website`, one row per business site. The same topic in AU and NZ gets one folder each (`dentists-au`, `dentists-nz`). Any sector is fine; a new topic is a new folder.
- **Never edit or overwrite an existing list** (owner decision 2026-10-29). If `<list>.<cc>.csv` exists, write `<list>-2.<cc>.csv`, then `-3`, … (the next free number; the unnumbered file counts as 1). Chains follow the same rule (`chains-2.au.csv`). `scripts/new-list.ts` picks the number. **One new file per list per session** (owner decision 2026-10-29): the first batch creates `-2` (or the next free number); every further batch in the same session (another source, a second country pass) goes into that same file with `--append`, never into a `-3` made in the same session. Only a later session starts the next number. Never merge into or append to the unnumbered base list.
- **A new numbered file holds only new sites:** anything already in any CSV of that category folder (same host + path, as `readSites()` dedupes) and in-file duplicates are dropped. That way `npm run scrape` only crawls the new file.
- **Keep** the business's own website. **Drop** social pages, delivery/ordering platforms (ubereats, menulog, doordash, facebook, instagram, linktr.ee, tripadvisor, yelp …), directories, and businesses that are not about the topic (the topic must show in the name, a tag or the site, not just a broad type like "restaurant").
- **Scope for a sector** is places whose tag, name or site shows the topic (pizza: `cuisine=pizza`, "pizz" in the name), not every broader type (Italian restaurants, pubs that list pizza). Chains go in their own `<topic>-chains` list, numbered the same way.
- **Targets:** the owner's per-country target for the sector (for example pizza: AU 5,000–8,100, NZ as many as exist) is reported against the real count. Never pad with unrelated businesses and never invent sites. Report per country: new sites, duplicates dropped, total in the category, sources used, and the shortfall.
- **Sources, in order:** OpenStreetMap through Overpass (`scripts/fetch-osm-places.ts <cc> <out.csv> --match=…`, selectors in its header and in docs/TODO.md), then public directories and web search for gaps, then a Google Places API key only if the owner gives one. Respect each source's terms and rate limits.
- **Procedure:** write candidates to the scratchpad, run `scripts/new-list.ts` (use `--dry-run` first), look at a sample, report. Don't scrape emails from a new list until the owner asks.

## Process hygiene

- Long runs go in the background with `nohup … &`. Wait on the **PID** (`while kill -0 <pid>; do sleep 30; done`).
- To stop a run, `kill` the PID printed in its first log line (`Run <id> started (pid N)`). Killing the `npm` PID does not reach the scraper and leaves it running.
- **Never** wait with `pgrep -f` or kill with `pkill -f` using a pattern that also appears in your own shell command. It matches itself, so the wait never ends or the kill takes out your own shell. This has happened here before.
- Two runs can't work on the same file: the second one skips it (`<file>.lock` holds the first run's PID). Never delete a lock by hand while that PID is alive.
- If a run is interrupted, re-running the same command (or a plain `npm run scrape`) resumes from the cache, also for interrupted `--force` re-scrapes (`<file>.inprogress` marks them). Don't delete the partial cache or the marker. An interrupted `--retry-*` run continues when the same command is run again.

## Code conventions

- ESM TypeScript run directly by `tsx`. There is no build output. Relative imports use the `.js` extension (`from './urls.js'`).
- The heuristics are tuned against real NZ healthcare and AU dealer/tourism sites. When changing `extract.ts` filters or name rules, run `scripts/recheck-cache.ts` and re-check a few known sites, looking for regressions: false person names, junk emails, lost emails. Keep regexes linear (anchor on literals, bound repetitions); a quadratic one can freeze the whole run.
- The CSV and the summary are always derived from `SiteResult` objects, whether fresh or cached, after `recheckSite()`. New fields must be optional, because old cache lines lack them (`budgetQueued`, `capQueued`, `errorDetail` and `resume` only exist from cache v3).
- After changing `output.ts` row assignment as well as `extract.ts`, run `npx tsx scripts/recheck-cache.ts`: it also previews which emails would be credited to another site.
- Keep comments sparse and explain *why*, matching the existing code.
