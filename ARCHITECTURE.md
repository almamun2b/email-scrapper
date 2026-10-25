# Architecture

This document explains how the email scraper is put together: the data flow, the responsibilities of each module, and the design decisions behind them. For usage, see [README.md](README.md).

## Overview

```
websites/<category>/<name>.csv
        │  paths.ts findInputs()/groupOf()/fileLayout(): category → results/<group>/
        │  input.ts readSites(): find the website column, normalise, dedupe by host+path+query
        ▼
┌──────────────── src/index.ts → src/run.ts ────────────────────┐
│  for each input file (in order; a failing one is skipped)     │
│    acquireLock(results/<group>/.cache/<name>.lock)             │
│    beginScrape(): resume (.inprogress) or rotate old cache    │
│    load results/<group>/.cache/<name>.jsonl  (resume / reuse)  │
│    --retry-*: planRetries() → re-crawl or continue a site     │
│    p-limit(--concurrency=12) over uncached sites:             │
│        runSite(): scrapeSite(site, opts, signal)              │
│                or resumeSite(prev, parts, opts, signal)       │
│                   abort at budget + 4 min, 30 s grace,        │
│                   then the pre-browser partial result         │
│        append SiteResult → <group>/.cache/<name>.jsonl        │
│    recheckSite() every result with the current rules          │
│    --check-mx: drop emails whose domain can't receive mail    │
│    assignRows(): credit each email to the site owning it;     │
│      → results/<group>/emails/<name>.csv                      │
│    writeSummary() → log + results/<group>/logs/<name>.log      │
│    endScrape(): remove .inprogress                            │
└───────────────────────────────────────────────────────────────┘
        │ scrapeSite(site)
        ▼
┌──────────────────────── src/crawler.ts ──────────────────────┐
│  Phase 1: crawl(start, httpFetcher, maxPages=0 (∞), sitemap)  │
│    tries https → http → www./bare variants until one loads    │
│  Phase 2 (conditional): crawl(landing, browserFetcher, 60)    │
│  businessName(homeHtml) · demoteRolePrefixes(emails)          │
│  leftover(): queue at the time limit or page cap + 429/503    │
│              pages → resume                                   │
└───────┬───────────────┬───────────────┬──────────────┬────────┘
        │ http.ts       │ browser.ts    │ robots.ts    │ sitemap.ts
        │ (netguard.ts) │ (netguard.ts) │              │
        ▼ every fetched page
┌──────────────────────── src/extract.ts ──────────────────────┐
│  extractFromDom($, html) → [{ email, name, source, nameFrom }]│
│  findEmails · cleanEmail · personName · nearbyName ·          │
│  consistentPerson · nameFromLocal · recheckRow                │
└───────────────────────────────────────────────────────────────┘
        ▲ URL decisions
┌──────────────────────── src/urls.ts ─────────────────────────┐
│  normalizeInput · canonical · crawlable · priority            │
│  sectionPrefix · inSection                                    │
└───────────────────────────────────────────────────────────────┘
```

Everything runs in a single Node.js process. TypeScript is executed directly by `node --import tsx` (a loader, not the `tsx` CLI, whose signal relay SIGKILLs a busy child before its shutdown handler runs); there is no build step (`tsconfig.json` has `noEmit`). The package is ESM (`"type": "module"`), so imports between source files use `.js` extensions.

## Core data types

```ts
// crawler.ts
interface SiteResult {          // one per input website; one JSON line in the cache
  v?: number;                   // cache schema version (3); absent on the oldest lines
  site: string;                 // normalised input URL (the CSV "website" column)
  finalUrl: string;             // landing URL after redirects
  business: string;             // business name for fallback naming
  emails: FoundOnPage[];
  pages: number;                // pages fetched successfully (HTTP + browser)
  usedBrowser: boolean;
  rateLimited?: number;         // pages skipped because the server kept answering 429/503
  budgetQueued?: number;        // pages still queued when the time budget ran out (v3, or marked from the logs)
  capQueued?: number;           // pages still queued when --max-pages was reached
  resume?: ResumeState;         // v3: what the --retry-budget-queued / --retry-rate-limited / --retry-capped runs continue from
  error?: string;               // 'unreachable' | 'robots-disallowed' | 'robots-unavailable' | 'timeout' | 'browser-error' | 'internal-error' (older lines: exception text)
  errorDetail?: string;         // why the landing page didn't load over HTTP: dns, refused, tls, timeout, reset, private, redirects, not-html, http-<status>
}

interface ResumeState {         // written only when something is left over
  queued: [url, depth][];       // HTTP queue left at the time limit or the page cap, best first (max 2000)
  capped?: boolean;             // `queued` was left by the page cap: only --retry-capped continues it
  limited: [url, depth][];      // HTTP pages refused with 429/503 after the retry
  seen?: string[];              // canonical URLs fetched or queued (minus `queued`): never fetched again
  attempts: number;             // HTTP page attempts used; they count toward --max-pages
  browser?: 'js-rendered' | 'no-emails'; // browser phase owed: time ran out before (or during) it
}

interface FoundOnPage {
  email: string;
  name: string | null;          // person name, only when confidently tied to the email
  source?: EmailSource;         // 'jsonld' | 'microdata' | 'mailto' | 'cfemail' | 'data-attr' | 'text' | 'raw'
  nameFrom?: 'page' | 'local';  // where the name came from
  link: string;                 // page where it was found
  pageTitle?: string;           // department title (section sub-pages only)
}
```

`SiteResult` is the contract between the crawler, the cache and the CSV/summary writer. The CSV and the summary log are always derived from `SiteResult`s, whether freshly scraped or loaded from the cache. That's why `--summary-only` and the `--retry-*` runs can rebuild outputs without re-crawling every site. **If you change `SiteResult`, older cache lines won't have the new fields.** Readers must treat new fields as optional (see `e.link ?? ''` and how `recheckRow()` handles a missing `nameFrom`).

## Module responsibilities

### `src/index.ts` and `src/run.ts`: orchestration

`index.ts` only handles the command line (`--help`, flags, file selection, `--dry-run`) and calls into `run.ts`, which holds the per-file work (`processFile()`, `runSite()`, `writeSummary()`, `runUnique()`, `previewFile()`, `staleState()`). `index.ts` runs `main()` on import, so everything testable lives in `run.ts`.

- **Layout (`src/paths.ts`):** every input maps to a group folder `results/<group>/` that holds its output CSVs in `results/<group>/emails/`, plus `.cache/` and `logs/`; the `--unique` lists go in `results/<group>/emails/unique/`. The group is the input's category folder (`websites/<category>/x.csv`, one level deep), else the file's own base name, so a list with no category gets a folder to itself. `fileLayout()` builds all the paths and `findInputs()` lists `websites/*.csv` plus `websites/*/*.csv`. `--unique` with no files writes one list per group folder, inside it; across groups it falls back to `results/unique/`. `filteredDir` (`emails/filtered/`) holds the `--include-suffix` / `--exclude-suffix` CSVs; `findOutputs()` reads only `emails/*.csv`, so they never feed `--unique`.
- **Target selection:** with no file arguments, it uses every input found by `findInputs()` whose output doesn't exist, plus any whose scrape was interrupted (`.inprogress` marker). `--force` and `--summary-only` lift that skip; the `--retry-*` flags take only inputs that have an output (there is nothing to retry otherwise). `--summary-only` and `--unique` refuse to be combined with a retry flag. Explicit file arguments are always processed. Two targets that would write the same output file are an error. A file that throws (an unreadable CSV, a lock held by another run, a bug) is logged and skipped, the other files still run, and the process exits with code 1 at the end.
- **`--dry-run`:** `previewFile()` says per target what `processFile()` would do (scrape, resume, rotate and re-scrape, retry counts from `planRetries()`, rebuild, or skip), reading the input and cache only; it takes no lock and writes nothing under `results/`. `staleState()` then lists `.inprogress` markers whose input is gone and locks whose PID is dead.
- **Startup order:** `--log-level` is read first and file logging starts before the rest of the command line is validated, so a bad flag still lands in `logs/error-<date>.log`.
- **Concurrency:** `--concurrency` sites at once (12). `runSite()` gives each site a hard limit of `budget + 4 min` (24 min by default). At the limit it aborts the site's `AbortSignal`; `scrapeSite` then stops its workers, sitemap loading, in-flight requests and any wait for a server or browser slot (`untilAborted()`, `abort.ts`), closes its browser page, and returns what it found with `error: 'timeout'`. If it still doesn't return within `STOP_GRACE_MS` (30 s), the site gets the partial result `scrapeSite`/`resumeSite` reported through `onPartial` just before the browser phase (with `error: 'timeout'`), else an empty one. If `scrapeSite` rejects, the error is logged with its stack and the site gets `error: 'internal-error'`, so the rest of the run continues. When `runSite()` continues a site (`resumeSite()`), the fallbacks return the site's earlier result instead of an empty one.
- **Retries:** `retryOptions()` gives the four independent retry flags (`--retry-capped` requires `--max-pages`). `planRetries()` (in `cache.ts`) sorts the cached rows: `--retry-failed` failures go to `recrawl`; rows selected by `--retry-rate-limited` / `--retry-budget-queued` / `--retry-capped` that have the saved state they need go to `resume` with the parts to work on; selected rows without it (pre-v3 rows, or rows marked by `scripts/mark-budget-from-logs.ts`) go to `recrawl` and, if they have emails, to `previous`. A re-crawled row in `previous` is passed to `mergeResults(prev, next)`: the old row's emails stay exactly as they were and only addresses the re-crawl found that it didn't have are added (owner decision), while the crawl state (`resume`, `budgetQueued`, `capQueued`, `rateLimited`, `v`) comes from the re-crawl, so a mark from the logs doesn't send the row into every later retry. `--retry-budget-queued=MIN` sets the run's `budgetMs` (an error together with `--budget`).
- **CSV and summary:** every `SiteResult` (fresh or cached) goes through `recheckSite()` first, so outputs always follow the current email and name rules. With `--check-mx`, `undeliverable()` (`mx.ts`) drops emails whose domain can't receive mail. Then `assignRows()` and `writeSummary()` run as below. CSVs are written atomically (`writeFileAtomic()`), new files `0600` in `0700` folders. The cache file is not rewritten.
- **Suffix filters:** `RunOptions.filter` (built by `suffixFilter()` in `cli.ts`, rules in `filter.ts`) is applied only to finished rows, never during the crawl or in `extract.ts`. `processFile()` writes the normal CSV and summary first, then `writeFiltered()` writes `emails/filtered/<name>.<tag>.csv` from the same assigned rows and appends a block to the list's log. For a list `index.ts` isn't going to scrape (output exists, or a retry run with nothing to retry), `filterFile()` does the cache-only part: lock, `loadCache()`, `recheckSite()` (and `--check-mx`), `assignRows()`, `writeFiltered()`; it skips an interrupted scrape or a missing cache and never writes the normal CSV. `writeUnique()` filters the combined list after `uniqueRows()` and writes `<label>.<tag>.csv` beside it. `--dry-run` appends the filtered path through `previewFile()`.
- **Summary:** `writeSummary()` prints the summary and appends it to `results/<group>/logs/<name>.log`. It counts sites with emails, sites with no emails, failed sites grouped by reason (with `errorDetail` counts per reason), partial results, `--check-mx` drops, rate-limited pages (`Limited`), sites that ran out of time with pages queued (`Out of time`, from `budgetRetry()`), sites that reached the page cap (`Capped`), sites missing from the cache, the name-source breakdown (person, department, input name, business), and top sites.

### `src/cli.ts`: command line

`USAGE` is the `--help` text; a test checks that every flag is in it. `parseArgs()` splits argv into boolean flags, numeric options (`--x=N` or `--x N`) and file paths, and throws on anything invalid: unknown flags, a value on a boolean flag (`--force=false`), and fractions for count options (only `--budget` may be fractional, and it must be above 0). `--retry-budget-queued` is the one flag whose value is optional (`OPTIONAL_NUMBER_FLAGS`): a following argument is taken as its value only if it is a number, so `--retry-budget-queued websites/a.csv` still reads the file. `RunOptions` (in `run.ts`) starts from `DEFAULT_OPTIONS` (deep) or `QUICK_OPTIONS` (`--quick`), and explicit options override it. The options are printed at start and included in the summary's mode string.

`--include-suffix` / `--exclude-suffix` are list flags (`LIST_FLAGS`): `--x=a,b`, `--x a,b` and `--x[a,b]` are read, repeats add up, and `parseSuffixes()` (in `filter.ts`) rejects anything that can't end a domain.

### `src/input.ts`: input files

`readSites()` finds the website column: an exact header (`website`, `url`, `domain`, `site`, `websites`, `link`), then a header containing `web`/`url`/`domain`/`site`/`link`, then the column with the most URL-like values in the first 200 rows. The first row is a header unless it holds a URL in that column. Rows are deduped on `siteKey()`: `baseHost(host) + path + sorted query` (trailing slash stripped), so `www.` duplicates merge while several dealer pages on one group domain stay separate. Invalid and duplicate counts are returned and logged. When the file has a header row, a name column (`name`, or `business|company|organisation|practice|clinic|church|club|dealer|store|venue name`) is returned as `names` (site → name); it is read from the input every time, never cached. UTF-16 files with a byte-order mark (Excel's "Unicode text", tab-separated) are decoded, stray quotes inside fields are tolerated (`relax_quotes`), and a file that still can't be parsed throws an error naming the line.

### `src/cache.ts`: cache lifecycle

Per input file, in `results/<group>/.cache/` (the group's cache dir is passed to `cacheFiles()`):
- `<name>.jsonl`: the only file the loaders read. Sites are appended as they finish.
- `<name>.inprogress`: written by `beginScrape()`, removed by `endScrape()` after the CSV and summary are written. If it exists at the start of a scrape, the scrape resumes from the cache instead of resetting. That's what makes an interrupted `--force` or explicit-file re-scrape resumable.
- `<name>.<YYYYMMDD-HHMMSS>.jsonl`: when a file with an existing output is scraped again (and isn't resuming), `beginScrape()` renames the old cache to this name instead of deleting it. The owner keeps every cache for later analysis.
- `.pages` and `.pages.lock` (one per category, not per list): the page store, see "Page store" below. Never rotated or deleted.
- `<name>.lock`: `acquireLock()` creates it exclusively (`wx`) with the PID. A live holder raises `LockedError` and `main()` skips that file. A lock whose PID is gone is stale and taken over. Locks are released in `finally` and by a synchronous `exit` handler (the signal handlers exit through `process.exit`).

A `--retry-*` run passes `keepCache` to `beginScrape()`, so the finished run's cache is reused in place, never rotated. The selection predicates never pick `robots-disallowed`:
- `failedRetry()`: `error` set and no emails.
- `rateLimitedRetry()`: on a v3 row, `resume.limited` is non-empty; on an older row (which only has the count), `rateLimited > 0`.
- `budgetRetry()`: `budgetQueued > 0`, `resume.queued` non-empty and not `capped`, or `resume.browser` set.
- `cappedRetry()`: `resume.capped` with `resume.queued` non-empty (v3 rows only; older rows have no saved queue).

`robots-unavailable` (a 5xx robots.txt) is a failure like any other, so `--retry-failed` picks it up.

`planRetries()` turns them into the plan (see `run.ts`). `processFile()` then rewrites the cache with `writeCacheAtomic()` (temp file and rename), dropping only the re-crawled rows with no emails. Rows being continued, and re-crawled rows that had emails (`previous`), stay in the file: the retry's row is appended after them (the last line wins in `loadCache()`), so an interrupted retry loses nothing and the same command picks the site up again. `--summary-only` refuses to run on a file with no cache or an `.inprogress` marker, so it can't overwrite a good CSV with an empty or partial one.

### `src/output.ts`: rows

- `recheckSite()` runs `recheckRow()` on every email, merges duplicates (a ROT13 decode can land on an address the site already had), runs `demoteRolePrefixes()`, and tidies the cached business name (`tidyBusinessName()`, falling back to the domain).
- `assignRows(sites, done, inputNames)`: one row per email across the whole file. Each email is credited to its **owner**: the first site whose registrable domain (tldts `getDomain` of the input URL or the landing URL) is the email's, else the first site where its `source` isn't `raw`, else the first site. Rows are ordered by the credited site's input position, then the email's order on that site. `name = e.name || e.pageTitle || inputNames.get(site) || r.business`, passed through `safeCell()`, which prefixes `'` to anything starting with `=`, `+`, `-`, `@`, tab or CR (CSV formula injection). It also counts which fallback named each row (`kinds`) for the summary. The columns are fixed: `name,email,website,link`.

### `src/filter.ts`: suffix filters

`SuffixFilter`: `keepEmail()` keeps an email when its domain matches an include suffix (if any) and no exclude suffix; `matchesSuffix()` compares at a dot boundary (`au` matches `x.com.au`, not `x.nau`; `gov` does not match `x.gov.au`). `filterTag()` names the output file from the sorted, deduplicated suffixes, so the same filter always writes the same file and different filters never collide. `filterRows()` also counts the dropped rows per domain ending (tldts public suffix) for the log.

### `src/crawler.ts`: crawling a site

**Fetchers.** `crawl()` is written against a `Fetcher = (url) => Promise<{html, url, disallowed?} | null>` (defined in `browser.ts`). There are two implementations: `httpFetcher()` on top of `httpGet()`, and `makeBrowserFetcher()`. `httpFetcher()` passes `robotsAllow` as `allowHop`, so a redirect hop that robots.txt disallows is never requested and comes back as `disallowed`; it also reports why a page failed (`onFail`) for `errorDetail`.

**`crawl()` algorithm:**
1. Load robots for the start origin. If the start URL is disallowed, return `blocked`.
2. Fetch the landing page. If the redirect went to another origin, load that origin's robots. If the landing URL is disallowed (by those rules, or as a refused redirect hop), return `blocked` (`robots-disallowed`, or `robots-unavailable` for a 5xx robots.txt).
3. Compute `section = sectionPrefix(inputUrl, landingUrl)`.
4. Parse the landing page once (`cheerio.load`), collect its links and department title, then extract emails (`extractFromDom` strips scripts from the DOM, so it goes last). For the HTTP phase, also enqueue sitemap URLs, filtered to the section if there is one.
5. Worker pool (`--page-concurrency`, 3, for HTTP; 2 for the browser): pop the best URL from `PageQueue` (a binary min-heap on priority, then insertion order), check it against the robots.txt of **its own origin** (`SiteCrawl.allows()`; the site's `www.`/bare and `http:`/`https:` variants and other ports are separate origins, and robots-parser answers `undefined` for a URL outside the origin it parsed, which `allowed()` would read as allowed), fetch it, and if it redirected, mark the target as seen and skip it when it left the site or landed on a disallowed path. Then extract emails and enqueue new links at `depth + 1`. Each page is wrapped in `try/catch`, so one bad page can never reject the site. Stop at the attempt cap, the deadline or the abort signal.

`collectLinks()` takes `a[href]` and `area[href]`, same-site `frame[src]`/`iframe[src]` (old framed sites), and `<meta http-equiv="refresh">` targets. `enqueue` drops links deeper than `maxDepth` (when it is non-zero), applies `crawlable()`, dedupes with `canonical()`, and checks robots for URLs on the landing origin (other origins are checked when popped). The landing page is level 0. Its links and sitemap seeds are level 1. `maxPages` counts attempts; `SiteResult.pages` counts successful fetches.

The per-site state (host, robots, section, `seen`, `PageQueue`, `depthOf`, emails, `enqueue`/`ingest`) lives in a `SiteCrawl`, and the worker pool is `runQueue()`. `crawl()` builds a `SiteCrawl` from the landing page and sitemap; `resumeSite()` builds one from a saved `ResumeState`. `runQueue()` returns why it stopped: `'time'` (deadline or abort signal with pages still queued), `'cap'` (`maxPages` attempts used with pages still queued) or `'done'`. A page whose fetch the hard stop cut off goes back into the queue (its attempt is given back), so it is saved too.

**Page store (`src/pages.ts`, `PageStore`).** One append-only file per category, `results/<group>/.cache/.pages`, opened once per process by `openPages()` in `run.ts` (guarded by `.pages.lock`, closed by `closePages()` in `index.ts`). A line is `<mode><key>\t<at>\t<json>`: mode `h` (plain HTTP) or `b` (browser, never mixed with `h`), key = `pageKey()` from `urls.ts` (canonical URL without the scheme, so tracking/session/empty params, order, `www.`, trailing slash and index files don't make a different page; content params like `?page=2` do), `at` = fetch time. The last line for a key wins; `{"gone":1}` is a 404/410. Memory holds only an index of `key → offset/length/at`; records are read back on demand. A `PageRecord` is site-independent: the page's `Found` emails, its `<h1>`/`<title>` as a possible department name, its crawlable same-site links, and `etag`/`lastModified`.
- `runQueue` calls `PageStore.load(mode, key, cutoff, fetch)`: a copy at least as new as `cutoff` is reused; a page another site is fetching right now is awaited (one request for 12 parallel sites); otherwise `fetch(stale)` runs, with the older copy so it can send `If-None-Match` / `If-Modified-Since`. A 304 re-appends the old record with a new `at`. A failed fetch is not remembered (waiting sites try themselves), except a 404/410.
- `cutoff` is per list, in `processFile()`: `startedAt − --revalidate days` (30 by default), or `startedAt` for a fresh re-scrape of a list (output exists, not a retry/`--new-only`/resume), so pages fetched during the run are never stale in it.
- Reused pages still count toward `--max-pages` (`attempts`), so a site's crawl is identical to one without the store; `SiteResult.reused` and the summary's `+ M reused` show how many requests were saved. The landing page is always requested (its HTML gives the business name and the JS-rendered check) but is stored for other sites. Sitemaps are memoised per run (`PageStore.sitemap`).

**Limits (`CrawlOptions`).** `scrapeSite(site, options, signal?)` merges `options` over `DEFAULT_OPTIONS`:

| | `DEFAULT_OPTIONS` (deep) | `QUICK_OPTIONS` |
|---|---|---|
| `maxPages` (HTTP attempts, 0 = unlimited) | 0 | 150 |
| `browserPages` (0 = no browser phase) | 60 | 30 |
| `maxDepth` (0 = unlimited) | 0 | 0 |
| `budgetMs` (soft) | 20 min | 10 min |

**`scrapeSite()` phases:**
- Phase 1 (HTTP) tries the `candidateStarts(site)` variants in order (https, http, then www. added or removed) until one yields a landing page. Why each failed is recorded; the first one's reason becomes `errorDetail`.
- Phase 2 (browser) runs when Phase 1 got no landing page, when the landing page `looksJsRendered()`, or when no emails were found, and only while the deadline hasn't passed. It is skipped when every start URL failed DNS, since Chromium can't load those either. Just before it, `onPartial` gets the result so far for the hard timeout. It starts at Phase 1's landing URL when there is one, otherwise it tries every candidate, `http://` included. Browser results are merged into Phase 1's.
- If Phase 1 reports `blocked`, the result is `error: 'robots-disallowed'` (or `'robots-unavailable'`) with no emails. If only Phase 2 is blocked, the error is set but Phase 1's emails are kept.
- An aborted scrape returns what it has with `error: 'timeout'`.
- **What's left is saved.** `leftover()` drains the HTTP queue in priority order if time ran out (`budgetQueued` is its full size) or the page cap was reached (`capQueued`, and `resume.capped`); at most `MAX_SAVED_QUEUE` = 2000 entries are kept. It collects the pages `httpFetcher()` reported as refused with 429/503 (it reports the URL asked for, not the redirect hop), and keeps `seen` minus the queued keys. Phase 2 owed but not run, or itself out of time, sets `resume.browser` (`'js-rendered'` if the HTTP landing page was missing or looked JS-rendered, else `'no-emails'`). `resume` is only written when something is left.
- The business name is computed from the landing page HTML. `demoteRolePrefixes()` then clears local-part names that are really per-branch role mailboxes.

**`resumeSite(prev, parts, options, signal?)`** continues a saved crawl:
- It reloads robots for `prev.finalUrl`. If the landing page is now disallowed, it returns `prev` unchanged.
- It rebuilds `section`, seeds `seen` from `resume.seen` plus every saved queued URL, and queues only the selected parts (`parts.budget`: a time-budget queue; `parts.capped`: a page-cap queue; `parts.limited`: the refused pages, whose attempts are given back). Unselected parts are carried over into the new state unchanged; a carried page-cap queue stays capped unless this pass runs out of time.
- Page cap (only when `--max-pages` is set): the continued crawl can use `maxPages − attempts`. If that is used up, nothing is fetched and the queue is kept (the log says to raise `--max-pages`).
- After the HTTP part, it runs Phase 2 from `finalUrl` if `parts.budget` and the browser is still owed (`'no-emails'` only while there are still none).
- The earlier emails are seeded into the hit map, so new hits only add or upgrade (`merge()`). `pages` and `rateLimited` are summed, a stale `timeout` error is dropped, and a fresh `budgetQueued` / `resume` describe what is still left.

**Merging hits:** `merge()` keeps the first page an email was seen on and replaces it only if a later hit supplies a person name. The same rule applies within a crawl, across the two phases, and between a resumed site's earlier and new results.

**Department titles:** `ingest()` computes `pageTitleOf($)` (`<h1>`, else the first segment of `<title>`) only when the crawl has a section and the page is inside it but isn't the landing page itself.

### `src/http.ts`: HTTP

- **`httpGet(url, { accept, types, signal, allowHop, onFail })`** follows redirects itself (`redirect: 'manual'`, at most 10 hops). Every hop must pass `isPublicHost()`, and `allowHop` (robots.txt of the hop's origin) before it is requested. Error statuses come back as results with an empty body (callers check `status`). Network failures, refused hosts and aborts return `null`, after reporting a `FailKind` through `onFail`.
- **Connections.** Requests use npm `undici`'s `fetch` with its own `Agent` whose `connect.lookup` is `guardedLookup()` (`netguard.ts`): each connection goes to exactly the addresses that were checked, so DNS rebinding can't slip a private address in, and each host is resolved once per 10 minutes instead of per connection.
- **Politeness.** Each hop goes through `withHostSlot()`: a per-server `p-limit(hostConcurrency)` (`--host-concurrency`, default 3) keyed by `baseHost`. Many input domains can redirect to one server (for example the NZ health boards all go to healthnz.govt.nz), so the limit is per server, not per site. Inside the slot, `waitTurn()` enforces a minimum gap between requests to that server: the larger of its robots.txt `Crawl-delay` and its rate-limit backoff (`hostGapMs()`, both capped at 10 s). `pace()` doubles the backoff on each 429/503 (1 s up to 10 s) and halves it on each other answer, so a throttling server is slowed for every site on it and recovers once it answers normally. The browser fetcher uses the same `withHostSlot()` and `notePace()`, so Crawl-delay, the backoff and the per-server cap hold in both phases. A queued wait gives up as soon as the site's signal aborts.
- **Retries.** 429/503 and transient network errors are retried once, after `Retry-After` (seconds or an HTTP date, kept within 1–30 s) or 3 s. Permanent errors (`ENOTFOUND`, `ECONNREFUSED`, TLS/certificate failures) are not. A page still refused with 429/503 is logged once per server at warn (later ones at debug) and reported through `onRateLimited`, which `scrapeSite()` counts into `SiteResult.rateLimited` for the progress line and the summary's `Limited` line.
- **Bodies.** Content types outside `types` are not downloaded (the body is cancelled). Bodies are capped at 5 MB and decoded with the charset from the header, else from a `<meta charset>` in the first 2 KB, else UTF-8.
- **Response bodies must always be consumed or cancelled.** The HTTP client is npm `undici` (also what `cheerio` pulls in, which installs its own `Agent` as the global dispatcher for Node's built-in `fetch`). If a body is left unread and the server closes the connection, undici throws `AssertionError` in `Parser.finish` from a socket event. That is uncatchable at the call site and used to kill the whole run. `request()` therefore cancels the body of every redirect, error response and skipped content type, and the reader of oversize pages. As a backstop, the process handler in `logger.ts` logs that specific assertion and keeps running.

### `src/browser.ts`: headless Chromium

One shared browser runs across the whole process, with a new context per site (`acceptDownloads: false`, `serviceWorkers: 'block'`) and at most 4 pages at a time globally (`browserLimit`; the wait gives up when the site aborts). It is launched with `chromiumSandbox: true` (Playwright's default is `--no-sandbox`) unless `SCRAPER_NO_SANDBOX=1`. If it disconnects or fails to launch, `browserPromise` is reset so the next request starts a new one; `newContext()` retries once when the browser died in between, and a page whose context died with the browser (`newPage()` fails with "closed") gets a fresh context once. The request guard is on the **context** (`context.route`), so popups are covered too, and popups are closed; it aborts images, fonts and media and anything on a non-public host (`isPublicHost()`). WebSockets get the same address check (`routeWebSocket`), and service workers are blocked because their requests bypass routing. Navigation goes through `withHostSlot()` (Crawl-delay, backoff, per-server cap) and closes the page on abort. Each page waits for `domcontentloaded` and then briefly for `networkidle`; responses with status ≥ 400 count as failures. Up to 10 same-site child frames' documents are appended to the page HTML. Redirects happen inside Chromium, so a disallowed redirect target is only caught after loading (and then discarded).

### `src/robots.ts` and `src/sitemap.ts`

- `loadRobots(origin)` is cached per origin for the run. A network failure means "no robots.txt". A 5xx (after one retry) is `ROBOTS_UNAVAILABLE`, which disallows everything (RFC 9309) and is reported as `robots-unavailable` (`blockReason()`). `robotsAllow(url)` checks a URL against its own origin's rules; `allowed(rules, url)` assumes the rules belong to the URL's origin. A 4xx, or a body that isn't a robots file, means no rules. A parsed file also registers its `Crawl-delay` with `http.ts`. Rules are matched with the Chrome user agent, which robots-parser reduces to `mozilla`, so in practice the `*` group applies.
- `loadSitemapUrls()` reads at most 8 sitemap files and 2000 URLs, stops at the deadline or abort, gunzips `.xml.gz` bodies (by magic bytes), and skips one bad entry instead of failing the whole load. Whether a `<loc>` is a sitemap or a page follows the root element (`<sitemapindex>` or `<urlset>`), and its XML escapes (`&amp;` …) are undone. Sub-sitemaps whose URL looks like stock, inventory, vehicles or products (`LISTING_SITEMAP`) are read last, so page and post sitemaps aren't crowded out by listings.

### `src/netguard.ts`: public addresses only

`isPublicHost(hostname)` resolves the host (cached for 10 minutes; failures aren't cached) and requires every address to be outside loopback, RFC 1918, link-local (including `169.254.169.254`), CGNAT, multicast, reserved and documentation ranges, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`), IPv6 ULA/link-local, and IPv4-mapped forms of those. A DNS failure counts as public, so the request fails with its real error. `guardedLookup()` is the same check as a `dns.lookup` replacement for undici's connections (code `EBLOCKED` on a private address). `setResolver()` swaps the resolver in tests. `SCRAPER_ALLOW_PRIVATE=1` disables the guard; the tests use it to crawl a server on 127.0.0.1.

### `src/mx.ts`: `--check-mx`

`canReceiveMail(domain)` asks DNS (c-ares via `dns.Resolver`, not the libuv thread pool) once per domain per run, 16 at a time: an MX record means yes, unless it is RFC 7505's null MX (`.`); without one, an A/AAAA record means yes (RFC 5321 implicit MX). Only a definite answer (`ENOTFOUND`, `ENODATA`) can say no; timeouts and server failures keep the email. `undeliverable(emails)` returns the ones to drop.

### `src/logger.ts`: diagnostics

- **One pino logger (`log`)** writes to a `pino.multistream`:
  - At import it has only a `pino-pretty` console stream (info+, no object fields). Scratch scripts that import `crawler.ts` therefore never write files. Because fields are hidden there, `consoleMessage()` prefixes `[host]` from the `site` field, appends the `url` field, and adds the first line of `err.message` (assertion messages are left out), each only when the message doesn't already say it.
  - `initFileLogging(level)`, called from `main()`, adds `logs/scraper-<date>.log` (at `--log-level` / `LOG_LEVEL`, default info) and `logs/error-<date>.log` (error+). Both are JSON lines written with `sync: true`, so nothing is lost on `process.exit` or a crash.
  - It also deletes this logger's own files older than `LOG_RETENTION_DAYS` (30).
- **Context:** `withLogContext(fields, fn)` stores fields in an `AsyncLocalStorage`. pino's `mixin` adds them to every line. `index.ts` wraps each file (`file`) and `run.ts` each site (`site`), so lines from deep inside `httpGet()` carry the site without passing a logger around. This works because p-limit preserves async context (it registers `.then` in the caller's context). Lines from the shared `robots.txt` cache carry the context of the first site that requested it.
- **`installProcessHandlers()`:**
  - `uncaughtException` and `unhandledRejection` are logged as `fatal`, then the process exits with code 1. The undici parser assertion above is the one exception: it is logged in plain words ("a server closed the connection mid-response"), at warn once per site and at debug after that, and the run continues.
  - Node `warning`s are logged as `warn`.
  - SIGINT and SIGTERM close the browser and exit with 130/143.
- **What is logged where:** run, file and site lifecycle at info. Failed sites, exhausted rate-limit retries, hard timeouts, skipped input rows and locked files at warn or error. Browser launch failures and site crashes at error. Every individual request failure (status, network error code, timeout), refused private address and skipped off-site redirect at debug.
- **Separate from the summaries:** `results/<group>/logs/<name>.log` (the human summary per input file) is separate and unchanged.

### `src/extract.ts`: emails and names

`extractFromDom($, html)` (and the wrapper `extractFromHtml(html)`) collects from several sources. Order matters, because a source that knows a name takes precedence. Each email records its first `source`:
1. JSON-LD `email` fields (`jsonld`), walked by the shared `walkJsonLd()`. The name comes from `@type` Person/Physician/Dentist.
2. Microdata `schema.org/Person` blocks (`microdata`).
3. `mailto:` links (`mailto`; URL-decoded, split on `,`/`;`, `?query` stripped) and Cloudflare `email-protection#hex` links (`cfemail`).
4. `[data-cfemail]` elements (`cfemail`, XOR-decoded) and `data-email`/`data-mail` attributes (`data-attr`).
5. The visible text (`text`): one walk over the text nodes builds both the text (joined with spaces so adjacent elements don't merge) and a map from each email to the element holding it, for name context. `deobfuscate()` is applied to the text first.
6. The raw HTML (`raw`), which catches addresses in attributes and scripts. These are the most junk-prone.

**Linear-time scanning.** `findEmails()` anchors on each `@` and matches a bounded local part (≤ 64 chars) and bounded domain labels around it. An unanchored `/[…]+@/` is quadratic on long runs without an `@` and once froze whole runs. `deobfuscate()` collapses whitespace first and starts every pattern with a literal for the same reason. `nearbyName()` memoises each container's text, email count and first heading, so a page with hundreds of emails isn't rescanned per email. A JSON escape right before an address (`"\ndavid@…"`) isn't taken as part of it.

`cleanEmail()` normalises and filters every candidate: lower-case, strip surrounding punctuation, validate the shape, drop asset names (`BAD_TLD_SUFFIX`), require a registrable domain under an ICANN public suffix (`tldts`), recover ROT13-scrambled addresses (only when the original domain is invalid, or is `.am`/`.pn`, and the decoded one is under a common suffix like `.com.au` or `.co.nz`), and drop junk domains (placeholders such as `email.com`, `company.com.au`, `test.co.nz`; platforms such as Wix, Squarespace and Podium form relays; a domain-parking service), placeholder local parts (`you`, `your`, `recipient`, …), local parts with `..` or a dot at either end, and hash/UUID local parts. `findEmails()` also cuts a domain at a lowercase→uppercase change in its last label, so text glued on after an address (`info@acme.co.nzPhone`) doesn't swallow it.

**Person name resolution:**
- `personName(text)` accepts 1–4 capitalised words (Unicode-aware, so macrons and accents pass) with an optional title (Dr, Prof, …), or 2–4 words without one. It rejects digits, `@`, and words in `NOT_NAME_WORDS`.
- `nearbyName()` walks up to 3 ancestors of the element holding the email. It gives up as soon as a container holds more than one distinct email, because that's a list rather than one person's card. It looks at headings, `strong`/`b` and `*name*`/`*title*` classes, then at the text right before the email (found case-insensitively).
- `consistentPerson(name, email)` is the key false-positive guard. A scraped name is kept only if a name word equals a whole token of the local part, or the local part is a usual form of the name (`jsmith`, `janes`, `smithj`, `janesmith`, `smithjane`), or it has a title and the mailbox isn't generic. Names made only of `DEPT_WORDS` are always rejected. Without this guard, page headings like "Party Space" or "Customer Care" would be attached to unrelated emails.
- `nameFromLocal()` is the last resort: `first.last@` becomes "First Last". It requires the first part to be in `src/data/given-names.txt` and no part to be a department word (`DEPT_WORDS`) or an organisational word (`LOCAL_STOP`: team, admin, region, NZ place names, …, matched as whole parts).
- `demoteRolePrefixes()` (per site) clears local-part names whose first part appears with 5 or more different second parts, such as `bec.<city>@` branch mailboxes.

**Re-checking stored rows.** `recheckRow()` re-applies `cleanEmail()` (dropping or decoding), recomputes local-part names with the current `nameFromLocal()`, and drops scraped names made only of department words. It knows a name came from the local part by `nameFrom`; for older rows without it, a name counts as local-derived only if it is the title-cased local part and the old rule could have produced it (2–3 parts of 3–12 letters). Fresh results pass through unchanged.

`businessName()` looks at JSON-LD `Organization`/`LocalBusiness`/medical types, then `og:site_name`/`application-name`, then the `<title>` segment that best matches the domain (segments under 4 characters don't count), and falls back to the domain. Every candidate goes through `tidyBusinessName()`: generic segments ("Home", "Welcome", "Untitled", …) are dropped, a leading "Welcome to" is removed, and an address after a comma ("…, 1/123 Main Road") is cut. `isGenericTitle()` keeps "Contact Us", "About" and the like from being used as department titles, both when crawling (`pageTitleOf()`) and when re-checking cached rows.

`looksJsRendered()` checks whether the body text is under 200 characters once scripts and styles are removed.

### `src/urls.ts`: URL policy

- `normalizeInput()` adds `https://`, repairs `www./domain`, and rejects non-http(s) URLs and hosts with an empty label or without a registrable domain under an ICANN suffix (IP addresses pass).
- `canonical()` is the dedupe key. It strips the fragment and `www.`, collapses slashes, removes the trailing slash and tracking parameters (`utm_*`, `fbclid`, `gclid`, …), and sorts the query.
- `crawlable()` requires the same site (`www.`-insensitive) and rejects file extensions, `SKIP_PATH` (uploads, wp-admin, login, cart, calendar, cdn-cgi, …), more than 2 query params, URLs over 250 characters, and paths more than 7 segments deep.
- `priority(url, depth, section?)` gives a score where lower is fetched sooner. Malformed percent-escapes in the path (`/100%-off`) are scored on the raw path:

  ```
  base  = 0 (contact/about/team/staff/meet/enquir/find-us)
        | 5 (other PRIORITY_PATH keywords)
        | 20 (everything else)
  score = base + 3·depth + 4·(has query) + (section ? (inside ? −20 : +15) : 0)
          + 40·(below a listing segment)
  ```

  `PRIORITY_PATH` also covers dealer and tourism departments: sales, parts, service, finance, fleet, accessories, careers, groups, trade, agents, media, partners, bookings, wholesale. A *listing segment* (`LISTING_SEGMENT`) is a non-final path segment such as `stock`, `inventory`, `new-cars`, `used-vehicles`, `demo`, `vehicles`, `showroom`, `offers`, `specials`, `news`, `blog`, `events` or `products`. Detail pages below it, like `/used-cars/<car>` or `/news/<post>`, are fetched last because they rarely carry emails and dealer sites have thousands of them. The bare index page (`/used-cars`) keeps its normal score, so its links are still discovered.

- `sectionPrefix(input, landing)` returns the landing path when the input URL had a path, when the redirect crossed domains, or when the path is 2+ segments deep. It returns `null` for `/`, `/index`, `/default` and `/home` (with or without an extension like `.html`), and for a shallow same-domain redirect.

## Testing

`npm test` runs `node --import tsx --test test/*.test.ts`. There are no network calls except one DNS lookup of a `.invalid` name: crawler tests run against `test/helpers/server.ts`, a small `node:http` server on 127.0.0.1 (and 127.0.0.2 for "another site", or another port for "another origin of the same site") that records each request's path and time, and the browser tests skip themselves when Chromium isn't installed. `processFile()` is tested end to end in a temp folder. `tsconfig.json` includes `test/` and `scripts/`, so `npm run typecheck` covers them too. CI (`.github/workflows/ci.yml`) runs both on Node 22 and 24 on every push and pull request, with Chromium installed (`SCRAPER_NO_SANDBOX=1`, as the runners restrict user namespaces).

`scripts/recheck-cache.ts` re-runs `recheckSite()` over every real cached row (via `loadCache()`, so superseded lines don't count) and reports dropped and decoded emails and changed names, then per file which emails `assignRows()` would credit to a different site than "first site wins", and how many rows get the input's name, without writing anything. Run it after changing `extract.ts` or `output.ts`. `scripts/given-names-report.ts` lists first parts of `first.last@` addresses missing from the given-name list, for review. `scripts/mark-budget-from-logs.ts` marks pre-v3 rows that the logs say ran out of time (`budgetQueued`), so `--retry-budget-queued` re-crawls them; it is a dry run unless given `--write`, only appends, takes the file's lock and skips files with an `.inprogress` marker.

## Key design decisions

| Decision | Reason |
|---|---|
| HTTP first, browser only as fallback | Most sites are server-rendered. Chromium is about 10× slower and much heavier, so it's used only when it's likely to help |
| Priority queue instead of plain BFS | With a page cap, contact/team pages must come first. Section bonus and penalty keep big multi-tenant sites focused |
| Deep crawl by default (no page cap since 2026-10-16; was 400; unlimited depth) + listing penalty | Owner decision (2026-10-02). On car dealer sites the old 150-page cap was spent on stock listings, before department pages were reached. `--quick` keeps the old limits |
| Respect robots.txt on the final host and in the browser | User decision (2026-09-29). Domains that redirect to a host disallowing generic bots report `robots-disallowed`. A 5xx robots.txt is a disallow (RFC 9309), reported as `robots-unavailable` so it can be retried. Every page and redirect hop is checked against its own origin's rules, and Crawl-delay holds in both phases (audit 2026-10-13) |
| Keep the Chrome user agent | Owner decision (2026-10-03). An honest bot UA would get more sites blocked |
| Per-server concurrency limit | Many inputs can share one server. Without the limit that server rate-limits or blocks, and sites fail |
| Soft budget (20 min) + abortable hard timeout (budget + 4 min) | Large sites keep what they found instead of losing everything to a timeout, and a stopped site no longer keeps running in the background |
| Save the queue at the time limit and the refused pages; separate retry flags | Owner decision (2026-10-13). Crawl-delay sites (10 s/page) and rate-limiting servers need more time, not a fresh crawl that fetches every page again. Continuing the saved state never refetches a page and never loses an email |
| Append-only JSONL cache, kept forever (rotated, never deleted) | Crash-safe resume, cheap `--retry-*` / `--summary-only`, and data for later heuristic tuning |
| Outputs re-check cached rows with the current rules | Heuristic fixes apply to existing outputs through `--summary-only`, without re-scraping |
| Suffix filters act on outputs, from the cache, into separate files | Owner decision (2026-10-23). The scrape stays complete, so a new filter never needs a re-crawl, and the normal CSV is always the full list. Suffix matching at a dot boundary keeps `.gov` and `.gov.au` distinct. No country filter |
| One row per email per file, credited to the site that owns it | Aggregator sites repeat the same addresses. Output is a contact list, not a page index. Dealer-locator data puts every dealer's email on every dealer site, so "first site wins" credited them to the wrong dealer |
| No shared file: every email goes into its own list's CSV | Owner decision (2026-10-16), reversing the 2026-10-13 `shared/` rule. Each website list produces exactly its own email CSV |
| Name order: person, department title, input name, scraped business name | Owner decision (2026-10-13). The input's own names are curated; scraped ones produced "Home" and "Welcome to …" |
| A re-crawl keeps the old row and only adds new emails | Owner decision (2026-10-13). A re-crawl that finds fewer emails (rate-limited, site changed) must not replace what was found before |
| Save the queue at the page cap too (`--retry-capped`) | Audit 2026-10-13: 18% of cached sites reached 400 pages. Going deeper later shouldn't mean starting over |
| Conservative person naming, given-name list for local parts | A wrong person name is worse than a business name. Owner decision (2026-10-03) |
| Sandboxed Chromium, public addresses only, formula-safe CSV | The scraper reads untrusted content from thousands of sites; none of it should reach the machine, the LAN, or the spreadsheet |
| pino JSON-lines logs in `logs/`, synchronous writes | Owner decision (2026-10-03). Machine-filterable (`jq`, log shippers), and crash-safe. The console stays human-readable via pino-pretty |

## Extending

- **New output column:** add it to `FoundOnPage`/`SiteResult` if it's per-email or per-site data, fill it in `crawler.ts`, then add it to the `Row` tuple in `output.ts` and `COLUMNS` in `run.ts`. Old cache lines won't have it, so default it.
- **New email source or obfuscation:** add it in `extractFromDom()` or `deobfuscate()` with its own `EmailSource`, and route every candidate through `cleanEmail()`. Keep scanning linear (anchor on literals, bound repetitions) and add a timing test.
- **New junk pattern:** extend `JUNK_DOMAINS`, `JUNK_LOCAL` or `BAD_TLD_SUFFIX` in `extract.ts`.
- **Name rules:** extend `DEPT_WORDS` or `src/data/given-names.txt`, then run `npx tsx scripts/recheck-cache.ts` and review the changes.
- **Crawl scope:** change `SKIP_EXT`, `SKIP_PATH`, `PRIORITY_PATH`, `LISTING_SEGMENT` in `urls.ts`, or `DEFAULT_OPTIONS`/`QUICK_OPTIONS` in `crawler.ts`.
- **New CLI flag:** add it to `BOOLEAN_FLAGS`, `INTEGER_FLAGS`, `NUMBER_FLAGS`, `OPTIONAL_NUMBER_FLAGS` or `STRING_FLAGS` in `cli.ts` and to `USAGE` (a test checks), read it in `main()` and pass it into `processFile()`. Keep the rule that the CSV and summary are derived from the `done` map, so every mode produces consistent outputs.
