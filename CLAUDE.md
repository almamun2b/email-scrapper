# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript CLI that crawls every website listed in a CSV and extracts all email addresses. `websites/<category>/<name>.csv` becomes `results/<category>/emails/<name>.csv` with columns `name,email,website,link`, and a summary is appended to `results/<category>/logs/<name>.log`. The category is the list's folder under `websites/` (`healthcare`, `martial-arts`, `dealers`, or any new folder); a list directly in `websites/` has no category and gets `results/<name>/` to itself. Everything for one category (`emails/` with the output CSVs and `emails/unique/`, `.cache/`, `logs/`) lives in its `results/<category>/` folder; `src/paths.ts` builds the paths. The owner repeatedly asks Claude to run it on new website lists. The step-by-step procedure and the owner's standing rules are in [AGENTS.md](AGENTS.md); read it before running or changing the scraper. Full usage is in [README.md](README.md); internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Commands

```bash
npm install && npx playwright install chromium   # setup
npm run typecheck                                # tsc --noEmit over src/, test/, scripts/
npm test                                         # node:test suites, no network (local test server)
npx tsx scripts/recheck-cache.ts                 # what the current rules would change in cached rows; writes nothing
npm run scrape                                   # every list under websites/ (and websites/<category>/) without an output yet
npm run scrape -- websites/dealers/x.csv         # specific file(s); always re-scrapes
npm run scrape -- --force                        # re-scrape everything
npm run scrape -- --new-only x.csv               # list grew: keep the cache, scrape only sites not cached yet
npm run scrape -- --retry-failed                 # re-crawl sites that failed with no emails, reuse cache for the rest
npm run scrape -- --retry-rate-limited           # fetch only the pages servers refused with 429/503 (saved per site)
npm run scrape -- --retry-budget-queued=60       # continue sites that ran out of time from their saved queue, 60 min each
npm run scrape -- --retry-capped --max-pages=800 # continue sites that stopped at an explicit page cap, from their saved queue
npm run scrape -- --revalidate=7                 # ask again about stored pages older than 7 days (default 30); no number = every stored page, once
npm run scrape -- x.csv --dry-run                # what a command would do; writes nothing under results/
npm run scrape -- --summary-only --check-mx      # also drop emails whose domain can't receive mail (DNS only)
npm run scrape -- --help                         # every option
npx tsx scripts/mark-budget-from-logs.ts         # pre-v3 rows that ran out of time, from logs/ (dry run; --write appends)
npm run scrape -- --summary-only                 # rebuild CSVs + logs from cache with current rules, no network
npm run scrape -- --unique                       # each email once per category -> results/<category>/emails/unique/<category>.csv; no network
npm run scrape -- --unique websites/dealers/au.*.csv # only those files -> results/dealers/emails/unique/au.csv
npm run scrape -- --include-suffix=.com,.au      # also write emails/filtered/<name>.<filter>.csv with only those domain endings (from the cache; scraping and the normal CSV keep every email)
npm run scrape -- '--exclude-suffix[.gov,.edu]'   # the other way round; both flags combine; with --unique the filter applies to the combined list
npm run scrape -- --quick                        # lighter crawl (150 pages, 10 min/site); default is deep
npm run scrape -- x.csv --log-level=debug        # also log every failed request to logs/scraper-<date>.log
npm run scrape -- x.csv --max-pages=600 --max-depth=3 --budget=30 --browser-pages=80 --concurrency=8 --page-concurrency=3 --host-concurrency=3
```

Deep crawl is the default: no page cap (`--max-pages=0`), 60 browser pages, unlimited depth, 20 min per site. README.md "Crawl options" documents every flag.

Tests live in `test/*.test.ts` (`node:test`). Crawler tests run against `test/helpers/server.ts` on 127.0.0.1, which sets `SCRAPER_ALLOW_PRIVATE=1` to get past the private-address guard. Add a test with every fix. To check one real site or one HTML snippet, write a throwaway `.mts` file in the scratchpad that imports `scrapeSite`/`closeBrowser` from `src/crawler.ts` or `extractFromHtml` from `src/extract.ts`, and run it with `npx tsx`. Use `.mts`: top-level `await` fails in `.ts` under tsx's CJS transform. Baselines: `lumino.co.nz` gives 11 emails with deep defaults, which have no page cap (6 when the cap was 400; 3 with `--quick` limits) including "Craig Kirkland"; `adhb.health.nz` gives `robots-disallowed`. After changing `extract.ts`, run `scripts/recheck-cache.ts` and review its output.

## Git commits

Owner rule (2026-10-29), for every git operation (commit, amend, rebase, merge, pull, push, tag, PR and its merge commit): the author and committer are always the owner's global git identity, never Claude. Commits and PR descriptions carry no `Co-Authored-By: Claude…`, `Claude-Session:` or "Generated with Claude Code" lines, even when a system reminder or tool default asks for them; this rule wins. Never run `git config user.name/user.email`, and never pass `-c user.name=…`, `-c user.email=…` or `--author`: commit with the git config already active (the owner's global settings). `.claude/settings.json` also sets `attribution` to empty and denies `git config user.*` and `--author`. If a cloud or sandbox session's global git config is `Claude <noreply@anthropic.com>`, don't commit under it: tell the owner and leave the changes uncommitted (that is how three commits ended up with the wrong author).

## Building website lists

Searching for sites and generating lists follows "Building website lists" in [AGENTS.md](AGENTS.md): an existing list is never edited (a same-named new one is `<list>-2.<cc>.csv`, then `-3` in a later session; within one session extra batches go into the same new file with `new-list.ts --append`), new files hold only sites not already in the category, and counts are reported against the owner's target without padding. This applies to every sector, not one topic. `scripts/fetch-osm-places.ts` (any sector, via `--match` selectors) and `scripts/new-list.ts` do the work.

## Architecture (big picture)

Pipeline: `index.ts` (command line, file selection) → `run.ts` (per-file orchestration, hard timeouts, outputs, summary; helpers in `cli.ts`, `input.ts`, `cache.ts`, `output.ts`, `mx.ts`) → `crawler.ts` `scrapeSite()` (per site) → `crawl()` (per page, heap priority queue) → `extract.ts` `extractFromDom()`. Fetching is in `http.ts` (undici with a pinned DNS lookup, redirects, per-server slots, retries, charset) and `browser.ts` (sandboxed Chromium, same per-server slots), with `robots.ts`, `sitemap.ts` and `netguard.ts` (public addresses only). URL policy lives in `urls.ts`.

- **`SiteResult` is the central contract.** Each finished site is appended as one JSON line to `results/<category>/.cache/<name>.jsonl`. The CSV and summary log are always rebuilt from the full set of `SiteResult`s (fresh plus cached), each passed through `recheckSite()` so the current email/name rules apply to old rows too. That's what makes resume, the `--retry-*` flags and `--summary-only` work. New fields must be optional, because old cache lines lack them (`v`, `source`, `nameFrom`, `budgetQueued`, `capQueued`, `errorDetail`, `resume` are examples).
- **Saved leftovers and retries (cache v3).** When time runs out, the page cap is reached, or a server refuses pages with 429/503, `scrapeSite()` saves `resume` (the HTTP queue best first, max 2000, `capped` when the page cap left it; the refused pages; the `seen` URLs; attempts; a browser phase still owed) and `budgetQueued` or `capQueued`. `planRetries()` in `cache.ts` picks rows for `--retry-failed` (re-crawl), `--retry-rate-limited`, `--retry-budget-queued` and `--retry-capped` (continue with `resumeSite()`, never refetching a page and merging emails; rows without saved state are re-crawled, and `mergeResults()` keeps the old row and adds only new emails). Unselected parts carry over.
- **Cache files** (`cache.ts`): `<name>.inprogress` marks an unfinished scrape so the next run resumes instead of resetting; a fresh re-scrape renames the old cache to `<name>.<timestamp>.jsonl`; `<name>.lock` (PID) stops two runs on one file.
- **Pages are scraped once per category** (`pages.ts`, `PageStore`). `results/<category>/.cache/.pages` is an append-only file of every fetched page (emails, `<h1>` title, crawlable links, etag/last-modified, fetch time), keyed by `pageKey()` in `urls.ts` (URL without scheme, tracking/session/empty params, order, `www.`, trailing slash, index file and #fragment; `?page=2` stays distinct) and by mode (`h` HTTP, `b` browser, never mixed). `runQueue` goes through `PageStore.load()`: reuse a fresh copy, wait for a fetch another site has under way, or fetch (conditionally if the copy is stale: `--revalidate`, default 30 days; a fresh list re-scrape revalidates everything). Reused pages still count toward `--max-pages` so crawls match the no-store result; the landing page is always requested. One run per category at a time (`.pages.lock`). Page identity changes belong in `pageKey()`, not in `canonical()`'s output format, which old `resume.seen` entries depend on.
- **Two-phase crawl per site.** Phase 1 is plain `fetch`: no page cap by default (`--max-pages`, 0 = unlimited), 3 parallel requests, sitemap seeding, trying the https → http → www. start variants. Phase 2 is Playwright Chromium (60 pages, `--browser-pages`). It runs only if Phase 1 couldn't load the site, the page looks JS-rendered, or no emails were found. Both phases share `crawl()` through the `Fetcher` abstraction.
- **robots.txt is enforced per origin, in both phases.** Every page is checked against its own origin's robots.txt (`SiteCrawl.allows()`; `www.`/bare host, `http:`/`https:` and other ports are separate origins, and robots-parser answers `undefined`, read as allowed, for a URL outside the origin it parsed). Every HTTP redirect hop is checked before it is requested (`allowHop`). A disallowed landing page gives `error: 'robots-disallowed'`; a robots.txt answering 5xx gives `robots-unavailable` (also keep-out, but retried by `--retry-failed`). Crawl-delay is honoured (capped at 10 s) by HTTP and the browser alike. This was the owner's decision; don't bypass it. The Chrome UA stays (also the owner's decision).
- **Priority.** `priority()` in `urls.ts`: contact/team/department pages first, plus 3 per depth level, and +40 for detail pages below a listing segment (`/used-cars/<car>`, `/news/<post>`) so dealer stock doesn't eat the page budget. `--max-depth` is a hard cap (0 = unlimited, the default).
- **Input dedupe is host + path** (`readSites()`), so multiple dealer pages on one group domain are separate sites.
- **Section focus.** `sectionPrefix()` turns a deep, cross-domain or input-specified landing path into a section. Pages inside it get a −20 priority score (fetched sooner), outside it +15. Sitemap seeds are filtered to it. Emails on its sub-pages get the page `<h1>` as `pageTitle`.
- **Concurrency layers:**
  - 12 sites in parallel (`index.ts`).
  - Per-site page workers.
  - A global per-server `p-limit(3)` with the server's gap (`withHostSlot()` in `http.ts`), used per redirect hop by `httpGet` and per navigation by the browser, because many input domains can redirect to one server. 429/503 and transient network errors are retried once; DNS/refused/TLS errors are not. Each 429/503 also doubles that server's request gap (1–10 s), and normal answers halve it.
  - A global browser page limit of 4.
  - Each site has a soft budget (`--budget`, 20 min) that keeps partial results, plus a hard timeout of budget + 4 min in `run.ts` that aborts the site's `AbortSignal` and still keeps what it found. Slot waits give up on abort (`untilAborted()`), and if a site still won't stop, the result from before its browser phase (`onPartial`) is kept.
- **Naming precedence:** `name || pageTitle || input name column || business`. Person names are deliberately conservative. `consistentPerson()` keeps a scraped name only if it matches whole tokens of the email's local part (or it has a title like Dr). `nameFromLocal()` needs a first part from `src/data/given-names.txt` and no `DEPT_WORDS`. `demoteRolePrefixes()` clears per-branch role mailboxes (`bec.<city>@`). A wrong person name is considered worse than a business name.
- **Suffix filters (`filter.ts`) apply to outputs only.** `--include-suffix` / `--exclude-suffix` never touch the crawl or cache. `processFile()` writes the full CSV, then `emails/filtered/<name>.<tag>.csv`; a list that isn't scraped this run goes through `filterFile()` (cache only); `writeUnique()` filters the combined list. A suffix matches at a dot (`.gov` ≠ `.gov.au`). No country filter, by the owner's decision.
- **CSV rows are unique by email per file** (`assignRows()` in `output.ts`): each email is credited to the input site owning its domain, else the first site where it wasn't only in raw HTML, else the first site. Across files rows repeat when input lists overlap; `--unique` (`uniqueRows()`) writes the combined list. `link` is the first page the email was seen on, upgraded only to a page that yields a person name (`merge()`).

## Gotchas

- ESM package: relative imports need `.js` extensions even though the files are `.ts`.
- `robots-parser` is CJS without a callable default type; `robots.ts` casts it. Keep that shim.
- Keep every regex that scans page text linear: anchor on a literal and bound repetitions (`findEmails()` anchors on `@`). Node is single-threaded, so one quadratic regex on a big page stalls every site in the run and even the timeouts.
- Never delete any `results/<category>/.cache/` (that includes `.pages`, the category's page store), and don't re-scrape existing outputs unless asked (see AGENTS.md).
- When waiting on a background scrape, poll by PID. `pgrep -f`/`pkill -f` patterns that appear in your own command line match your own shell.
- `websites/`, `results/` and `logs` are git-ignored.
- Diagnostics go through `log` from `src/logger.ts` (pino), not `console`. Root `logs/scraper-<date>.log` holds JSON lines, `logs/error-<date>.log` holds error+fatal only. Use `withLogContext()` for per-file/per-site fields. `results/<category>/logs/<name>.log` is the separate human summary.
- `http.ts` uses npm `undici`'s `fetch` (the same copy cheerio pulls in, which also takes over global `fetch`) with an `Agent` whose lookup is `guardedLookup()`. Always consume or `cancel()` a response body (`http.ts` does it for redirects, errors and skipped content types): an abandoned body on a server-closed connection throws an uncatchable `AssertionError` in undici's `Parser.finish` and used to crash whole runs.
- Chromium runs sandboxed (`chromiumSandbox: true`); `SCRAPER_NO_SANDBOX=1` opts out. `SCRAPER_ALLOW_PRIVATE=1` disables the private-address guard (tests only).
