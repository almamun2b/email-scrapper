# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript CLI that crawls every website listed in a CSV and extracts all email addresses. `websites/<name>.csv` becomes `emails/<name>.csv` with columns `name,email,website,link`, and a summary is appended to `emails/logs/<name>.log`. The owner repeatedly asks Claude to run it on new website lists. The step-by-step procedure and the owner's standing rules are in [AGENTS.md](AGENTS.md); read it before running or changing the scraper. Full usage is in [README.md](README.md); internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Commands

```bash
npm install && npx playwright install chromium   # setup
npm run typecheck                                # tsc --noEmit over src/, test/, scripts/
npm test                                         # node:test suites, no network (local test server)
npx tsx scripts/recheck-cache.ts                 # what the current rules would change in cached rows; writes nothing
npm run scrape                                   # all websites/*.csv without an output yet
npm run scrape -- websites/x.csv                 # specific file(s); always re-scrapes
npm run scrape -- --force                        # re-scrape everything
npm run scrape -- --retry-failed                 # re-crawl only failed or rate-limited sites, reuse cache for the rest
npm run scrape -- --summary-only                 # rebuild CSVs + logs from cache with current rules, no network
npm run scrape -- --unique                       # each email once across all emails/*.csv -> emails/unique/all.csv; no network
npm run scrape -- --unique websites/au.*.csv     # only those files -> emails/unique/au.csv
npm run scrape -- --quick                        # lighter crawl (150 pages, 10 min/site); default is deep
npm run scrape -- x.csv --log-level=debug        # also log every failed request to logs/scraper-<date>.log
npm run scrape -- x.csv --max-pages=600 --max-depth=3 --budget=30 --browser-pages=80 --concurrency=8 --page-concurrency=3 --host-concurrency=3
```

Deep crawl is the default: 400 HTTP pages, 60 browser pages, unlimited depth, 20 min per site. README.md "Crawl options" documents every flag.

Tests live in `test/*.test.ts` (`node:test`). Crawler tests run against `test/helpers/server.ts` on 127.0.0.1, which sets `SCRAPER_ALLOW_PRIVATE=1` to get past the private-address guard. Add a test with every fix. To check one real site or one HTML snippet, write a throwaway `.mts` file in the scratchpad that imports `scrapeSite`/`closeBrowser` from `src/crawler.ts` or `extractFromHtml` from `src/extract.ts`, and run it with `npx tsx`. Use `.mts`: top-level `await` fails in `.ts` under tsx's CJS transform. Baselines: `lumino.co.nz` gives 6 emails with deep defaults (3 with `--quick` limits) including "Craig Kirkland"; `adhb.health.nz` gives `robots-disallowed`. After changing `extract.ts`, run `scripts/recheck-cache.ts` and review its output.

## Architecture (big picture)

Pipeline: `index.ts` (per-file orchestration; helpers in `cli.ts`, `input.ts`, `cache.ts`, `output.ts`) → `crawler.ts` `scrapeSite()` (per site) → `crawl()` (per page, heap priority queue) → `extract.ts` `extractFromDom()`. Fetching is in `http.ts` (redirects, limits, retries, charset) and `browser.ts` (sandboxed Chromium), with `robots.ts`, `sitemap.ts` and `netguard.ts` (public addresses only). URL policy lives in `urls.ts`.

- **`SiteResult` is the central contract.** Each finished site is appended as one JSON line to `emails/.cache/<name>.jsonl`. The CSV and summary log are always rebuilt from the full set of `SiteResult`s (fresh plus cached), each passed through `recheckSite()` so the current email/name rules apply to old rows too. That's what makes resume, `--retry-failed` and `--summary-only` work. New fields must be optional, because old cache lines lack them (`v`, `source`, `nameFrom` are examples).
- **Cache files** (`cache.ts`): `<name>.inprogress` marks an unfinished scrape so the next run resumes instead of resetting; a fresh re-scrape renames the old cache to `<name>.<timestamp>.jsonl`; `<name>.lock` (PID) stops two runs on one file.
- **Two-phase crawl per site.** Phase 1 is plain `fetch`: 400 pages by default (`--max-pages`), 3 parallel requests, sitemap seeding, trying the https → http → www. start variants. Phase 2 is Playwright Chromium (60 pages, `--browser-pages`). It runs only if Phase 1 couldn't load the site, the page looks JS-rendered, or no emails were found. Both phases share `crawl()` through the `Fetcher` abstraction.
- **robots.txt is enforced on the start origin and again on the host reached after a redirect, in both phases.** A disallowed landing page gives `error: 'robots-disallowed'`, and so does a robots.txt answering 5xx. Crawl-delay is honoured (capped at 10 s). This was the owner's decision; don't bypass it. The Chrome UA stays (also the owner's decision).
- **Priority.** `priority()` in `urls.ts`: contact/team/department pages first, plus 3 per depth level, and +40 for detail pages below a listing segment (`/used-cars/<car>`, `/news/<post>`) so dealer stock doesn't eat the page budget. `--max-depth` is a hard cap (0 = unlimited, the default).
- **Input dedupe is host + path** (`readSites()`), so multiple dealer pages on one group domain are separate sites.
- **Section focus.** `sectionPrefix()` turns a deep, cross-domain or input-specified landing path into a section. Pages inside it get a −20 priority score (fetched sooner), outside it +15. Sitemap seeds are filtered to it. Emails on its sub-pages get the page `<h1>` as `pageTitle`.
- **Concurrency layers:**
  - 12 sites in parallel (`index.ts`).
  - Per-site page workers.
  - A global per-server `p-limit(3)` inside `httpGet` (per redirect hop), because many input domains can redirect to one server. 429/503 and transient network errors are retried once; DNS/refused/TLS errors are not. Each 429/503 also doubles that server's request gap (1–10 s), and normal answers halve it.
  - A global browser page limit of 4.
  - Each site has a soft budget (`--budget`, 20 min) that keeps partial results, plus a hard timeout of budget + 4 min in `index.ts` that aborts the site's `AbortSignal` and still keeps what it found.
- **Naming precedence:** `name || pageTitle || business`. Person names are deliberately conservative. `consistentPerson()` keeps a scraped name only if it matches whole tokens of the email's local part (or it has a title like Dr). `nameFromLocal()` needs a first part from `src/data/given-names.txt` and no `DEPT_WORDS`. `demoteRolePrefixes()` clears per-branch role mailboxes (`bec.<city>@`). A wrong person name is considered worse than a business name.
- **CSV rows are unique by email per file**, in input-site order (first site wins). Across files they repeat when input lists overlap; `--unique` (`uniqueRows()` in `output.ts`) writes the combined list. `link` is the first page the email was seen on, upgraded only to a page that yields a person name (`merge()`).

## Gotchas

- ESM package: relative imports need `.js` extensions even though the files are `.ts`.
- `robots-parser` is CJS without a callable default type; `robots.ts` casts it. Keep that shim.
- Keep every regex that scans page text linear: anchor on a literal and bound repetitions (`findEmails()` anchors on `@`). Node is single-threaded, so one quadratic regex on a big page stalls every site in the run and even the timeouts.
- Never delete `emails/.cache/`, and don't re-scrape existing outputs unless asked (see AGENTS.md).
- When waiting on a background scrape, poll by PID. `pgrep -f`/`pkill -f` patterns that appear in your own command line match your own shell.
- `websites/`, `emails/` and `logs` are git-ignored.
- Diagnostics go through `log` from `src/logger.ts` (pino), not `console`. Root `logs/scraper-<date>.log` holds JSON lines, `logs/error-<date>.log` holds error+fatal only. Use `withLogContext()` for per-file/per-site fields. `emails/logs/<name>.log` is the separate human summary.
- cheerio pulls in npm `undici`, which takes over global `fetch`. Always consume or `cancel()` a response body (`http.ts` does it for redirects, errors and skipped content types): an abandoned body on a server-closed connection throws an uncatchable `AssertionError` in undici's `Parser.finish` and used to crash whole runs.
- Chromium runs sandboxed (`chromiumSandbox: true`); `SCRAPER_NO_SANDBOX=1` opts out. `SCRAPER_ALLOW_PRIVATE=1` disables the private-address guard (tests only).
