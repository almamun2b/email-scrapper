# Architecture

This document explains how the email scraper is put together: the data flow, the responsibilities of each module, and the design decisions behind them. For usage, see [README.md](README.md).

## Overview

```
websites/<category>/<name>.csv
        │  paths.ts findInputs()/groupOf()/fileLayout(): category → emails/<group>/
        │  input.ts readSites(): find the website column, normalise, dedupe by host+path+query
        ▼
┌──────────────────────── src/index.ts ────────────────────────┐
│  for each input file (sequential)                             │
│    acquireLock(emails/<group>/.cache/<name>.lock)             │
│    beginScrape(): resume (.inprogress) or rotate old cache    │
│    load emails/<group>/.cache/<name>.jsonl  (resume / reuse)  │
│    p-limit(--concurrency=12) over uncached sites:             │
│        runSite(): scrapeSite(site, opts, signal)              │
│                   abort at budget + 4 min, 30 s grace         │
│        append SiteResult → <group>/.cache/<name>.jsonl        │
│    recheckSite() every result with the current rules          │
│    build CSV (input order, unique by email, formula-safe)     │
│    writeSummary() → log + emails/<group>/logs/<name>.log      │
│    endScrape(): remove .inprogress                            │
└───────────────────────────────────────────────────────────────┘
        │ scrapeSite(site)
        ▼
┌──────────────────────── src/crawler.ts ──────────────────────┐
│  Phase 1: crawl(start, httpFetcher, maxPages=400, sitemap)    │
│    tries https → http → www./bare variants until one loads    │
│  Phase 2 (conditional): crawl(landing, browserFetcher, 60)    │
│  businessName(homeHtml) · demoteRolePrefixes(emails)          │
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
  v?: number;                   // cache schema version (2); absent on older lines
  site: string;                 // normalised input URL (the CSV "website" column)
  finalUrl: string;             // landing URL after redirects
  business: string;             // business name for fallback naming
  emails: FoundOnPage[];
  pages: number;                // pages fetched successfully (HTTP + browser)
  usedBrowser: boolean;
  rateLimited?: number;         // pages skipped because the server kept answering 429/503
  error?: string;               // 'unreachable' | 'robots-disallowed' | 'timeout' | 'browser-error' | 'internal-error' (older lines: exception text)
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

`SiteResult` is the contract between the crawler, the cache and the CSV/summary writer. The CSV and the summary log are always derived from `SiteResult`s, whether freshly scraped or loaded from the cache. That's why `--summary-only` and `--retry-failed` can rebuild outputs without re-crawling. **If you change `SiteResult`, older cache lines won't have the new fields.** Readers must treat new fields as optional (see `e.link ?? ''` and how `recheckRow()` handles a missing `nameFrom`).

## Module responsibilities

### `src/index.ts`: orchestration

- **Layout (`src/paths.ts`):** every input maps to a group folder `emails/<group>/` that holds its output CSVs in `emails/<group>/emails/`, plus `.cache/`, `logs/` and `unique/`. The group is the input's category folder (`websites/<category>/x.csv`, one level deep), else the file's own base name, so a list with no category gets a folder to itself. `fileLayout()` builds all the paths and `findInputs()` lists `websites/*.csv` plus `websites/*/*.csv`. `--unique` with no files writes one list per group folder, inside it; across groups it falls back to `emails/unique/`.
- **Target selection:** with no file arguments, it uses every input found by `findInputs()` whose output doesn't exist, plus any whose scrape was interrupted (`.inprogress` marker). `--force`, `--retry-failed` and `--summary-only` lift that skip. Explicit file arguments are always processed. Two targets that would write the same output file are an error.
- **Startup order:** `--log-level` is read first and file logging starts before the rest of the command line is validated, so a bad flag still lands in `logs/error-<date>.log`.
- **Concurrency:** `--concurrency` sites at once (12). `runSite()` gives each site a hard limit of `budget + 4 min` (24 min by default). At the limit it aborts the site's `AbortSignal`; `scrapeSite` then stops its workers, sitemap loading and in-flight requests and returns what it found with `error: 'timeout'`. Only if it doesn't return within `STOP_GRACE_MS` (30 s) does the site get an empty `timeout` result. If `scrapeSite` rejects, the error is logged with its stack and the site gets `error: 'internal-error'`, so the rest of the run continues.
- **CSV and summary:** every `SiteResult` (fresh or cached) goes through `recheckSite()` first, so outputs always follow the current email and name rules. Then `buildRows()` and `writeSummary()` run as below. The cache file is not rewritten.
- **Summary:** `writeSummary()` prints the summary and appends it to `emails/<group>/logs/<name>.log`. It counts sites with emails, sites with no emails, failed sites grouped by reason, partial results, sites missing from the cache, the name-source breakdown, and top sites.

### `src/cli.ts`: command line

`parseArgs()` splits argv into boolean flags, numeric options (`--x=N` or `--x N`) and file paths, and throws on anything invalid: unknown flags, a value on a boolean flag (`--force=false`), and fractions for count options (only `--budget` may be fractional). `RunOptions` (in `index.ts`) starts from `DEFAULT_OPTIONS` (deep) or `QUICK_OPTIONS` (`--quick`), and explicit options override it. The options are printed at start and included in the summary's mode string.

### `src/input.ts`: input files

`readSites()` finds the website column: an exact header (`website`, `url`, `domain`, `site`, `websites`, `link`), then a header containing `web`/`url`/`domain`/`site`/`link`, then the column with the most URL-like values in the first 200 rows. The first row is a header unless it holds a URL in that column. Rows are deduped on `siteKey()`: `baseHost(host) + path + sorted query` (trailing slash stripped), so `www.` duplicates merge while several dealer pages on one group domain stay separate. Invalid and duplicate counts are returned and logged.

### `src/cache.ts`: cache lifecycle

Per input file, in `emails/<group>/.cache/` (the group's cache dir is passed to `cacheFiles()`):
- `<name>.jsonl`: the only file the loaders read. Sites are appended as they finish.
- `<name>.inprogress`: written by `beginScrape()`, removed by `endScrape()` after the CSV and summary are written. If it exists at the start of a scrape, the scrape resumes from the cache instead of resetting. That's what makes an interrupted `--force` or explicit-file re-scrape resumable.
- `<name>.<YYYYMMDD-HHMMSS>.jsonl`: when a file with an existing output is scraped again (and isn't resuming), `beginScrape()` renames the old cache to this name instead of deleting it. The owner keeps every cache for later analysis.
- `<name>.lock`: `acquireLock()` creates it exclusively (`wx`) with the PID. A live holder raises `LockedError` and `main()` skips that file. A lock whose PID is gone is stale and taken over. Locks are released in `finally` and by a synchronous `exit` handler (the signal handlers exit through `process.exit`).

`--retry-failed` passes `keepCache` to `beginScrape()`, so the finished run's cache is reused in place, never rotated. It drops only `isRetryable()` results (`error` set with no emails, or `rateLimited > 0`; never `robots-disallowed`) and rewrites the cache with `writeCacheAtomic()` (temp file and rename). Rate-limited results that had emails stay in the file and in a `previous` map: the retry's row is appended after them (the last line wins in `loadCache()`), and a retry that finds fewer emails keeps the previous result instead. `--summary-only` refuses to run on a file with no cache or an `.inprogress` marker, so it can't overwrite a good CSV with an empty or partial one.

### `src/output.ts`: rows

- `recheckSite()` runs `recheckRow()` on every email, merges duplicates (a ROT13 decode can land on an address the site already had) and runs `demoteRolePrefixes()`.
- `buildRows()`: rows in input order, unique by email across the whole file (first site wins). `name = e.name || e.pageTitle || r.business`, passed through `safeCell()`, which prefixes `'` to anything starting with `=`, `+`, `-`, `@`, tab or CR (CSV formula injection). The columns are fixed: `name,email,website,link`.

### `src/crawler.ts`: crawling a site

**Fetchers.** `crawl()` is written against a `Fetcher = (url) => Promise<{html, url} | null>` (defined in `browser.ts`). There are two implementations: `httpFetcher()` on top of `httpGet()`, and `makeBrowserFetcher()`.

**`crawl()` algorithm:**
1. Load robots for the start origin. If the start URL is disallowed, return `blocked`.
2. Fetch the landing page. If the redirect went to another origin, load that origin's robots. If the landing URL is disallowed there, return `blocked`.
3. Compute `section = sectionPrefix(inputUrl, landingUrl)`.
4. Parse the landing page once (`cheerio.load`), collect its links and department title, then extract emails (`extractFromDom` strips scripts from the DOM, so it goes last). For the HTTP phase, also enqueue sitemap URLs, filtered to the section if there is one.
5. Worker pool (`--page-concurrency`, 3, for HTTP; 2 for the browser): pop the best URL from `PageQueue` (a binary min-heap on priority, then insertion order), fetch it, and if it redirected, mark the target as seen and skip it when it left the site or landed on a robots-disallowed path. Then extract emails and enqueue new links at `depth + 1`. Each page is wrapped in `try/catch`, so one bad page can never reject the site. Stop at the attempt cap, the deadline or the abort signal.

`enqueue` drops links deeper than `maxDepth` (when it is non-zero), applies `crawlable()`, dedupes with `canonical()`, and checks robots. The landing page is level 0. Its links and sitemap seeds are level 1. `maxPages` counts attempts; `SiteResult.pages` counts successful fetches.

**Limits (`CrawlOptions`).** `scrapeSite(site, options, signal?)` merges `options` over `DEFAULT_OPTIONS`:

| | `DEFAULT_OPTIONS` (deep) | `QUICK_OPTIONS` |
|---|---|---|
| `maxPages` (HTTP attempts) | 400 | 150 |
| `browserPages` (0 = no browser phase) | 60 | 30 |
| `maxDepth` (0 = unlimited) | 0 | 0 |
| `budgetMs` (soft) | 20 min | 10 min |

**`scrapeSite()` phases:**
- Phase 1 (HTTP) tries the `candidateStarts(site)` variants in order (https, http, then www. added or removed) until one yields a landing page.
- Phase 2 (browser) runs when Phase 1 got no landing page, when the landing page `looksJsRendered()`, or when no emails were found, and only while the deadline hasn't passed. It starts at Phase 1's landing URL when there is one, otherwise it tries every candidate, `http://` included. Browser results are merged into Phase 1's.
- If Phase 1 reports `blocked`, the result is `error: 'robots-disallowed'` with no emails. If only Phase 2 is blocked, the error is set but Phase 1's emails are kept.
- An aborted scrape returns what it has with `error: 'timeout'`.
- The business name is computed from the landing page HTML. `demoteRolePrefixes()` then clears local-part names that are really per-branch role mailboxes.

**Merging hits:** `merge()` keeps the first page an email was seen on and replaces it only if a later hit supplies a person name. The same rule applies within a crawl and across the two phases.

**Department titles:** `ingest()` computes `pageTitleOf($)` (`<h1>`, else the first segment of `<title>`) only when the crawl has a section and the page is inside it but isn't the landing page itself.

### `src/http.ts`: HTTP

- **`httpGet(url, { accept, types, signal })`** follows redirects itself (`redirect: 'manual'`, at most 10 hops). Every hop must pass `isPublicHost()`. Error statuses come back as results with an empty body (callers check `status`). Network failures, refused hosts and aborts return `null`.
- **Politeness.** Each hop goes through a per-server `p-limit(hostConcurrency)` (`--host-concurrency`, default 3) keyed by `baseHost`. Many input domains can redirect to one server (for example the NZ health boards all go to healthnz.govt.nz), so the limit is per server, not per site. Inside the slot, `waitTurn()` enforces a minimum gap between requests to that server: the larger of its robots.txt `Crawl-delay` and its rate-limit backoff (`hostGapMs()`, both capped at 10 s). `pace()` doubles the backoff on each 429/503 (1 s up to 10 s) and halves it on each other answer, so a throttling server is slowed for every site on it and recovers once it answers normally.
- **Retries.** 429/503 and transient network errors are retried once, after `Retry-After` (seconds or an HTTP date, kept within 1–30 s) or 3 s. Permanent errors (`ENOTFOUND`, `ECONNREFUSED`, TLS/certificate failures) are not. A page still refused with 429/503 is logged once per server at warn (later ones at debug) and reported through `onRateLimited`, which `scrapeSite()` counts into `SiteResult.rateLimited` for the progress line and the summary's `Limited` line.
- **Bodies.** Content types outside `types` are not downloaded (the body is cancelled). Bodies are capped at 5 MB and decoded with the charset from the header, else from a `<meta charset>` in the first 2 KB, else UTF-8.
- **Response bodies must always be consumed or cancelled.** `cheerio` imports npm `undici`, which installs its own `Agent` as the global dispatcher, so Node's built-in `fetch` runs through `node_modules/undici`. If a body is left unread and the server closes the connection, undici throws `AssertionError` in `Parser.finish` from a socket event. That is uncatchable at the call site and used to kill the whole run. `request()` therefore cancels the body of every redirect, error response and skipped content type, and the reader of oversize pages. As a backstop, the process handler in `logger.ts` logs that specific assertion and keeps running.

### `src/browser.ts`: headless Chromium

One shared browser runs across the whole process, with a new context per site (`acceptDownloads: false`) and at most 4 pages at a time globally (`browserLimit`). It is launched with `chromiumSandbox: true` (Playwright's default is `--no-sandbox`) unless `SCRAPER_NO_SANDBOX=1`. If it disconnects or fails to launch, `browserPromise` is reset so the next request starts a new one, and `newContext()` retries once when the browser died in between. Requests for images, fonts and media are aborted, and so are requests to non-public hosts (`isPublicHost()`). Each page waits for `domcontentloaded` and then briefly for `networkidle`; responses with status ≥ 400 count as failures.

### `src/robots.ts` and `src/sitemap.ts`

- `loadRobots(origin)` is cached per origin for the run. A network failure means "no robots.txt". A 5xx (after one retry) is `DISALLOW_ALL`, following RFC 9309. A 4xx, or a body that isn't a robots file, means no rules. A parsed file also registers its `Crawl-delay` with `http.ts`. Rules are matched with the Chrome user agent, which robots-parser reduces to `mozilla`, so in practice the `*` group applies.
- `loadSitemapUrls()` reads at most 8 sitemap files and 2000 URLs, stops at the deadline or abort, gunzips `.xml.gz` bodies (by magic bytes), and skips one bad entry instead of failing the whole load. Sub-sitemaps whose URL looks like stock, inventory, vehicles or products (`LISTING_SITEMAP`) are read last, so page and post sitemaps aren't crowded out by listings.

### `src/netguard.ts`: public addresses only

`isPublicHost(hostname)` resolves the host (cached) and requires every address to be outside loopback, RFC 1918, link-local (including `169.254.169.254`), CGNAT, multicast and reserved ranges, IPv6 ULA/link-local, and IPv4-mapped forms of those. A DNS failure counts as public, so the request fails with its real error. `SCRAPER_ALLOW_PRIVATE=1` disables the guard; the tests use it to crawl a server on 127.0.0.1.

### `src/logger.ts`: diagnostics

- **One pino logger (`log`)** writes to a `pino.multistream`:
  - At import it has only a `pino-pretty` console stream (info+, no object fields). Scratch scripts that import `crawler.ts` therefore never write files. Because fields are hidden there, `consoleMessage()` prefixes `[host]` from the `site` field, appends the `url` field, and adds the first line of `err.message` (assertion messages are left out), each only when the message doesn't already say it.
  - `initFileLogging(level)`, called from `main()`, adds `logs/scraper-<date>.log` (at `--log-level` / `LOG_LEVEL`, default info) and `logs/error-<date>.log` (error+). Both are JSON lines written with `sync: true`, so nothing is lost on `process.exit` or a crash.
  - It also deletes this logger's own files older than `LOG_RETENTION_DAYS` (30).
- **Context:** `withLogContext(fields, fn)` stores fields in an `AsyncLocalStorage`. pino's `mixin` adds them to every line. `index.ts` wraps each file (`file`) and each site (`site`), so lines from deep inside `httpGet()` carry the site without passing a logger around. This works because p-limit preserves async context (it registers `.then` in the caller's context). Lines from the shared `robots.txt` cache carry the context of the first site that requested it.
- **`installProcessHandlers()`:**
  - `uncaughtException` and `unhandledRejection` are logged as `fatal`, then the process exits with code 1. The undici parser assertion above is the one exception: it is logged in plain words ("a server closed the connection mid-response"), at warn once per site and at debug after that, and the run continues.
  - Node `warning`s are logged as `warn`.
  - SIGINT and SIGTERM close the browser and exit with 130/143.
- **What is logged where:** run, file and site lifecycle at info. Failed sites, exhausted rate-limit retries, hard timeouts, skipped input rows and locked files at warn or error. Browser launch failures and site crashes at error. Every individual request failure (status, network error code, timeout), refused private address and skipped off-site redirect at debug.
- **Separate from the summaries:** `emails/<group>/logs/<name>.log` (the human summary per input file) is separate and unchanged.

### `src/extract.ts`: emails and names

`extractFromDom($, html)` (and the wrapper `extractFromHtml(html)`) collects from several sources. Order matters, because a source that knows a name takes precedence. Each email records its first `source`:
1. JSON-LD `email` fields (`jsonld`), walked by the shared `walkJsonLd()`. The name comes from `@type` Person/Physician/Dentist.
2. Microdata `schema.org/Person` blocks (`microdata`).
3. `mailto:` links (`mailto`; URL-decoded, split on `,`/`;`, `?query` stripped) and Cloudflare `email-protection#hex` links (`cfemail`).
4. `[data-cfemail]` elements (`cfemail`, XOR-decoded) and `data-email`/`data-mail` attributes (`data-attr`).
5. The visible text (`text`): one walk over the text nodes builds both the text (joined with spaces so adjacent elements don't merge) and a map from each email to the element holding it, for name context. `deobfuscate()` is applied to the text first.
6. The raw HTML (`raw`), which catches addresses in attributes and scripts. These are the most junk-prone.

**Linear-time scanning.** `findEmails()` anchors on each `@` and matches a bounded local part (≤ 64 chars) and bounded domain labels around it. An unanchored `/[…]+@/` is quadratic on long runs without an `@` and once froze whole runs. `deobfuscate()` collapses whitespace first and starts every pattern with a literal for the same reason. `nearbyName()` memoises each container's text, email count and first heading, so a page with hundreds of emails isn't rescanned per email. A JSON escape right before an address (`"\ndavid@…"`) isn't taken as part of it.

`cleanEmail()` normalises and filters every candidate: lower-case, strip surrounding punctuation, validate the shape, drop asset names (`BAD_TLD_SUFFIX`), require a registrable domain under an ICANN public suffix (`tldts`), recover ROT13-scrambled addresses (only when the original domain is invalid, or is `.am`/`.pn`, and the decoded one is under a common suffix like `.com.au` or `.co.nz`), and drop junk domains, placeholder local parts, and hash/UUID local parts.

**Person name resolution:**
- `personName(text)` accepts 1–4 capitalised words (Unicode-aware, so macrons and accents pass) with an optional title (Dr, Prof, …), or 2–4 words without one. It rejects digits, `@`, and words in `NOT_NAME_WORDS`.
- `nearbyName()` walks up to 3 ancestors of the element holding the email. It gives up as soon as a container holds more than one distinct email, because that's a list rather than one person's card. It looks at headings, `strong`/`b` and `*name*`/`*title*` classes, then at the text right before the email (found case-insensitively).
- `consistentPerson(name, email)` is the key false-positive guard. A scraped name is kept only if a name word equals a whole token of the local part, or the local part is a usual form of the name (`jsmith`, `janes`, `smithj`, `janesmith`, `smithjane`), or it has a title and the mailbox isn't generic. Names made only of `DEPT_WORDS` are always rejected. Without this guard, page headings like "Party Space" or "Customer Care" would be attached to unrelated emails.
- `nameFromLocal()` is the last resort: `first.last@` becomes "First Last". It requires the first part to be in `src/data/given-names.txt` and no part to be a department word (`DEPT_WORDS`) or an organisational word (`LOCAL_STOP`: team, admin, region, NZ place names, …, matched as whole parts).
- `demoteRolePrefixes()` (per site) clears local-part names whose first part appears with 5 or more different second parts, such as `bec.<city>@` branch mailboxes.

**Re-checking stored rows.** `recheckRow()` re-applies `cleanEmail()` (dropping or decoding), recomputes local-part names with the current `nameFromLocal()`, and drops scraped names made only of department words. It knows a name came from the local part by `nameFrom`; for older rows without it, a name counts as local-derived only if it is the title-cased local part and the old rule could have produced it (2–3 parts of 3–12 letters). Fresh results pass through unchanged.

`businessName()` looks at JSON-LD `Organization`/`LocalBusiness`/medical types, then `og:site_name`/`application-name`, then the `<title>` segment that best matches the domain (segments under 4 characters don't count), and falls back to the domain.

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

`npm test` runs `node --import tsx --test test/*.test.ts`. There are no network calls: crawler tests run against `test/helpers/server.ts`, a small `node:http` server on 127.0.0.1 (and 127.0.0.2 for "another site"), and the browser-fallback test skips itself when Chromium isn't installed. `tsconfig.json` includes `test/` and `scripts/`, so `npm run typecheck` covers them too. CI (`.github/workflows/ci.yml`) runs both on every push and pull request.

`scripts/recheck-cache.ts` re-runs `recheckSite()` over every real cached row and reports dropped and decoded emails and changed names, without writing anything. Run it after changing `extract.ts`. `scripts/given-names-report.ts` lists first parts of `first.last@` addresses missing from the given-name list, for review.

## Key design decisions

| Decision | Reason |
|---|---|
| HTTP first, browser only as fallback | Most sites are server-rendered. Chromium is about 10× slower and much heavier, so it's used only when it's likely to help |
| Priority queue instead of plain BFS | With a page cap, contact/team pages must come first. Section bonus and penalty keep big multi-tenant sites focused |
| Deep crawl by default (400 pages, unlimited depth) + listing penalty | Owner decision (2026-10-02). On car dealer sites the old 150-page cap was spent on stock listings, before department pages were reached. `--quick` keeps the old limits |
| Respect robots.txt on the final host and in the browser | User decision (2026-09-29). Domains that redirect to a host disallowing generic bots report `robots-disallowed`. A 5xx robots.txt is a disallow (RFC 9309), and Crawl-delay is honoured |
| Keep the Chrome user agent | Owner decision (2026-10-03). An honest bot UA would get more sites blocked |
| Per-server concurrency limit | Many inputs can share one server. Without the limit that server rate-limits or blocks, and sites fail |
| Soft budget (20 min) + abortable hard timeout (budget + 4 min) | Large sites keep what they found instead of losing everything to a timeout, and a stopped site no longer keeps running in the background |
| Append-only JSONL cache, kept forever (rotated, never deleted) | Crash-safe resume, cheap `--retry-failed` / `--summary-only`, and data for later heuristic tuning |
| Outputs re-check cached rows with the current rules | Heuristic fixes apply to existing outputs through `--summary-only`, without re-scraping |
| One row per email per file | Aggregator sites repeat the same addresses. Output is a contact list, not a page index |
| Conservative person naming, given-name list for local parts | A wrong person name is worse than a business name. Owner decision (2026-10-03) |
| Sandboxed Chromium, public addresses only, formula-safe CSV | The scraper reads untrusted content from thousands of sites; none of it should reach the machine, the LAN, or the spreadsheet |
| pino JSON-lines logs in `logs/`, synchronous writes | Owner decision (2026-10-03). Machine-filterable (`jq`, log shippers), and crash-safe. The console stays human-readable via pino-pretty |

## Extending

- **New output column:** add it to `FoundOnPage`/`SiteResult` if it's per-email or per-site data, fill it in `crawler.ts`, then add it to the `Row` tuple in `output.ts` and `columns` in `processFile()`. Old cache lines won't have it, so default it.
- **New email source or obfuscation:** add it in `extractFromDom()` or `deobfuscate()` with its own `EmailSource`, and route every candidate through `cleanEmail()`. Keep scanning linear (anchor on literals, bound repetitions) and add a timing test.
- **New junk pattern:** extend `JUNK_DOMAINS`, `JUNK_LOCAL` or `BAD_TLD_SUFFIX` in `extract.ts`.
- **Name rules:** extend `DEPT_WORDS` or `src/data/given-names.txt`, then run `npx tsx scripts/recheck-cache.ts` and review the changes.
- **Crawl scope:** change `SKIP_EXT`, `SKIP_PATH`, `PRIORITY_PATH`, `LISTING_SEGMENT` in `urls.ts`, or `DEFAULT_OPTIONS`/`QUICK_OPTIONS` in `crawler.ts`.
- **New CLI flag:** add it to `BOOLEAN_FLAGS`, `INTEGER_FLAGS`, `NUMBER_FLAGS` or `STRING_FLAGS` in `cli.ts`, read it in `main()` and pass it into `processFile()`. Keep the rule that the CSV and summary are derived from the `done` map, so every mode produces consistent outputs.
