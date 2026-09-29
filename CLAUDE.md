# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TypeScript CLI that crawls every website listed in a CSV and extracts all email addresses. `websites/<name>.csv` becomes `emails/<name>.csv` with columns `name,email,website,link`, and a summary is appended to `emails/logs/<name>.log`. The owner repeatedly asks Claude to run it on new website lists. The step-by-step procedure and the owner's standing rules are in [AGENTS.md](AGENTS.md); read it before running or changing the scraper. Full usage is in [README.md](README.md); internals are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Commands

```bash
npm install && npx playwright install chromium   # setup
npm run typecheck                                # tsc --noEmit; the only automated check
npm run scrape                                   # all websites/*.csv without an output yet
npm run scrape -- websites/x.csv                 # specific file(s); always re-scrapes
npm run scrape -- --force                        # re-scrape everything
npm run scrape -- --retry-failed                 # re-crawl only failed sites, reuse cache for the rest
npm run scrape -- --summary-only                 # rebuild CSVs + logs from cache, no network
```

There are no tests. To check one site or one HTML snippet, write a throwaway `.mts` file in the scratchpad that imports `scrapeSite`/`closeBrowser` from `src/crawler.ts` or `extractFromHtml` from `src/extract.ts`, and run it with `npx tsx`. Use `.mts`: top-level `await` fails in `.ts` under tsx's CJS transform. Baselines: `lumino.co.nz` gives 3 emails including "Craig Kirkland"; `adhb.health.nz` gives `robots-disallowed`.

## Architecture (big picture)

Pipeline: `index.ts` (per-file orchestration) → `crawler.ts` `scrapeSite()` (per site) → `crawl()` (per page, priority queue) → `extract.ts` `extractFromHtml()`. URL policy lives in `urls.ts`.

- **`SiteResult` is the central contract.** Each finished site is appended as one JSON line to `emails/.cache/<name>.jsonl`. The CSV and summary log are always rebuilt from the full set of `SiteResult`s (fresh plus cached). That's what makes resume, `--retry-failed` and `--summary-only` work. New fields must be optional, because old cache lines lack them.
- **Two-phase crawl per site.** Phase 1 is plain `fetch`: 150 pages, 3 parallel requests, sitemap seeding, trying the https → http → www. start variants. Phase 2 is Playwright Chromium (30 pages). It runs only if Phase 1 couldn't load the site, the page looks JS-rendered, or no emails were found. Both phases share `crawl()` through the `Fetcher` abstraction.
- **robots.txt is enforced on the start origin and again on the host reached after a redirect, in both phases.** A disallowed landing page gives `error: 'robots-disallowed'`. This was the owner's decision; don't bypass it.
- **Section focus.** `sectionPrefix()` turns a deep, cross-domain or input-specified landing path into a section. Pages inside it get a −20 priority score (fetched sooner), outside it +15. Sitemap seeds are filtered to it. Emails on its sub-pages get the page `<h1>` as `pageTitle`.
- **Concurrency layers:**
  - 12 sites in parallel (`index.ts`).
  - Per-site page workers.
  - A global per-server `p-limit(3)` inside `httpGet`, because many input domains can redirect to one server. 429/503 responses are retried once.
  - A global browser page limit of 4.
  - Each site has a 10-minute soft budget that keeps partial results, plus a 14-minute hard timeout in `index.ts`.
- **Naming precedence:** `name || pageTitle || business`. Person names are deliberately conservative. `consistentPerson()` keeps a scraped name only if it matches the email's local part (or it has a title like Dr). `nameFromLocal()` rejects generic and organisational mailboxes. A wrong person name is considered worse than a business name.
- **CSV rows are unique by email per file**, in input-site order (first site wins). `link` is the first page the email was seen on, upgraded only to a page that yields a person name (`merge()`).

## Gotchas

- ESM package: relative imports need `.js` extensions even though the files are `.ts`.
- `robots-parser` is CJS without a callable default type; `crawler.ts` casts it. Keep that shim.
- Never delete `emails/.cache/`, and don't re-scrape existing outputs unless asked (see AGENTS.md).
- When waiting on a background scrape, poll by PID. `pgrep -f`/`pkill -f` patterns that appear in your own command line match your own shell.
- `websites/`, `emails/` and `logs` are git-ignored.
