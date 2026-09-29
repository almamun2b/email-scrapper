# Architecture

This document explains how the email scraper is put together: the data flow, the responsibilities of each module, and the design decisions behind them. For usage, see [README.md](README.md).

## Overview

```
websites/<name>.csv
        │  readSites(): detect column, normalise, dedupe by host
        ▼
┌──────────────────────── src/index.ts ────────────────────────┐
│  for each input file (sequential)                             │
│    load emails/.cache/<name>.jsonl  (resume / reuse)          │
│    p-limit(SITE_CONCURRENCY=12) over uncached sites:          │
│        withTimeout(scrapeSite(site), 14 min)                  │
│        append SiteResult → .cache/<name>.jsonl                │
│    build CSV (input order, unique by email)                   │
│    writeSummary() → console + emails/logs/<name>.log          │
└───────────────────────────────────────────────────────────────┘
        │ scrapeSite(site)
        ▼
┌──────────────────────── src/crawler.ts ──────────────────────┐
│  Phase 1: crawl(start, httpFetcher, 150 pages, sitemap)       │
│    tries https → http → www. variants until one loads          │
│  Phase 2 (conditional): crawl(start, browserFetcher, 30 pages) │
│  businessName(homeHtml)                                       │
└───────────────────────────────────────────────────────────────┘
        │ every fetched page
        ▼
┌──────────────────────── src/extract.ts ──────────────────────┐
│  extractFromHtml(html) → [{ email, name | null }]             │
│  cleanEmail · personName · nearbyName · nameFromLocal         │
└───────────────────────────────────────────────────────────────┘
        ▲ URL decisions
┌──────────────────────── src/urls.ts ─────────────────────────┐
│  normalizeInput · canonical · crawlable · priority            │
│  sectionPrefix · inSection                                    │
└───────────────────────────────────────────────────────────────┘
```

Everything runs in a single Node.js process. TypeScript is executed directly with `tsx`; there is no build step (`tsconfig.json` has `noEmit`). The package is ESM (`"type": "module"`), so imports between source files use `.js` extensions.

## Core data types

```ts
// crawler.ts
interface SiteResult {          // one per input website; one JSON line in the cache
  site: string;                 // normalised input URL (the CSV "website" column)
  finalUrl: string;             // landing URL after redirects
  business: string;             // business name for fallback naming
  emails: FoundOnPage[];
  pages: number;                // pages fetched (HTTP + browser)
  usedBrowser: boolean;
  error?: string;               // 'unreachable' | 'robots-disallowed' | 'timeout' | exception text
}

interface FoundOnPage {
  email: string;
  name: string | null;          // person name, only when confidently tied to the email
  link: string;                 // page where it was found
  pageTitle?: string;           // department title (section sub-pages only)
}
```

`SiteResult` is the contract between the crawler, the cache and the CSV/summary writer. The CSV and the summary log are always derived from `SiteResult`s, whether freshly scraped or loaded from the cache. That's why `--summary-only` and `--retry-failed` can rebuild outputs without re-crawling. **If you change `SiteResult`, older cache lines won't have the new fields.** Readers must treat new fields as optional (see `e.link ?? ''`).

## Module responsibilities

### `src/index.ts` — orchestration

- **Target selection:** with no file arguments, it uses all `websites/*.csv` whose output doesn't exist. `--force`, `--retry-failed` and `--summary-only` lift that skip. Explicit file arguments are always processed.
- **Cache lifecycle** (`emails/.cache/<name>.jsonl`):
  - If an output exists and this is a plain or forced scrape, the cache is deleted and the file is scraped from scratch.
  - Otherwise existing lines are loaded into `done`, which gives resume-after-interrupt.
  - With `--retry-failed`, lines with an `error` are dropped and the cache is rewritten before scraping, so only failed sites are re-crawled.
  - The cache is **never deleted after a successful run**. The user relies on it for later analysis.
- **Concurrency:** 12 sites at once. Each site is wrapped in a 14-minute hard timeout that yields an empty `error: 'timeout'` result. `scrapeSite` normally stops itself earlier (10-minute budget) and keeps partial results.
- **CSV:** rows are built in input order and are unique by email across the whole file (first site wins). `name = e.name || e.pageTitle || r.business`. The columns are fixed: `name,email,website,link`.
- **Summary:** `writeSummary()` prints the summary and appends it to `emails/logs/<name>.log`. It counts sites with emails, sites with no emails, failed sites grouped by reason, partial results, name-source breakdown, and top sites.

### `src/crawler.ts` — fetching and crawling

**Fetchers.** `crawl()` is written against a `Fetcher = (url) => Promise<{html, url} | null>`. There are two implementations:
- `httpFetcher` uses Node's `fetch`, follows redirects, streams the body up to 5 MB and rejects non-HTML content types.
- `makeBrowserFetcher()` uses Playwright Chromium. One shared browser runs across the whole process, with a new context per site and at most 4 pages at a time globally (`browserLimit`). Images, fonts and media are blocked. Each page waits for `domcontentloaded` and then briefly for `networkidle`.

**HTTP politeness.** `httpGet()` goes through a per-server `p-limit(HOST_CONCURRENCY=3)` keyed by `baseHost`. Many input domains can redirect to one server (for example the NZ health boards all go to healthnz.govt.nz), so the limit is per server, not per site. A 429/503 response or a network error returns `'retry'`, and the request is retried once after 3 s.

**`crawl()` algorithm:**
1. Load robots for the start origin. If the start URL is disallowed, return `blocked`.
2. Fetch the landing page. If the redirect went to another origin, load that origin's robots. If the landing URL is disallowed there, return `blocked`.
3. Compute `section = sectionPrefix(inputUrl, landingUrl)`.
4. Extract emails from the landing page, then enqueue its links. For the HTTP phase, also enqueue sitemap URLs, filtered to the section if there is one.
5. Worker pool (3 for HTTP, 2 for the browser): pop the lowest-priority-score URL, fetch it, extract emails, and enqueue new links at `depth + 1`. Stop at the page cap or the deadline.

`enqueue` applies `crawlable()`, dedupes with `canonical()`, and checks `robots.isAllowed()`.

**`scrapeSite()` phases:**
- Phase 1 (HTTP) tries the `candidateStarts(site)` variants in order (https, http, www.) until one yields a landing page.
- Phase 2 (browser) runs when Phase 1 got no landing page, when the landing page `looksJsRendered()`, or when no emails were found, and only while the deadline hasn't passed. Browser results are merged into Phase 1's.
- If either phase reports `blocked`, the result is `error: 'robots-disallowed'` with no emails.
- The business name is computed from the landing page HTML.

**Merging hits:** `merge()` keeps the first page an email was seen on and replaces it only if a later hit supplies a person name. The same rule applies within a crawl and across the two phases.

**Department titles:** `ingest()` computes `pageTitleOf(html)` (`<h1>`, else the first segment of `<title>`) only when the crawl has a section and the page is inside it but isn't the landing page itself.

### `src/extract.ts` — emails and names

`extractFromHtml(html)` collects from several sources. Order matters, because a source that knows a name takes precedence:
1. JSON-LD / schema.org `email` fields. The name comes from `@type` Person/Physician/Dentist.
2. Microdata `schema.org/Person` blocks.
3. `mailto:` links (URL-decoded, split on `,`/`;`, `?query` stripped) and Cloudflare `email-protection#hex` links.
4. `[data-cfemail]` elements (XOR-decoded) and `data-email`/`data-mail` attributes.
5. A regex over the visible text. The HTML is flattened with a space per tag so adjacent elements don't merge into one string. `deobfuscate()` is applied first.
6. A regex over the raw HTML, which catches addresses in attributes and scripts.

`cleanEmail()` normalises and filters every candidate: lower-case, strip surrounding punctuation, validate the shape, check the TLD (any 2-letter ccTLD or an allow-listed gTLD), and drop asset names, junk domains, placeholder local parts, and hash/UUID local parts.

**Person name resolution:**
- `personName(text)` accepts 1–4 capitalised words with an optional title (Dr, Prof, …), or 2–4 words without one. It rejects digits, `@`, and words in `NOT_NAME_WORDS`.
- `nearbyName()` walks up to 3 ancestors of the element holding the email. It gives up as soon as a container holds more than one distinct email, because that's a list rather than one person's card. It looks at headings, `strong`/`b` and `*name*`/`*title*` classes.
- `consistentPerson(name, email)` is the key false-positive guard. A scraped name is kept only if one of its words (or initial+surname) appears in the email's local part, or it has a title and the mailbox isn't generic. Without this guard, page headings like "Party Space" would be attached to unrelated emails.
- `nameFromLocal()` is the last resort: `first.last@` becomes "First Last". It is blocked for generic mailboxes and for local parts containing organisational words (`LOCAL_STOP`: team, admin, region, NZ place names, …).

`businessName()` looks at JSON-LD `Organization`/`LocalBusiness`/medical types, then `og:site_name`/`application-name`, then the `<title>` segment that best matches the domain, and falls back to the domain.

`looksJsRendered()` checks whether the body text is under 200 characters once scripts and styles are removed.

### `src/urls.ts` — URL policy

- `normalizeInput()` adds `https://` and rejects non-http(s) URLs and hostnames without a dot.
- `canonical()` is the dedupe key. It strips the fragment and `www.`, collapses slashes, removes the trailing slash and tracking parameters (`utm_*`, `fbclid`, `gclid`, …), and sorts the query.
- `crawlable()` requires the same site (`www.`-insensitive) and rejects file extensions, `SKIP_PATH` (uploads, wp-admin, login, cart, calendar, cdn-cgi, …), more than 2 query params, URLs over 250 characters, and paths more than 8 segments deep.
- `priority(url, depth, section?)` gives a score where lower is fetched sooner:

  ```
  base  = 0 (contact/about/team/staff/meet/enquir/find-us)
        | 5 (other PRIORITY_PATH keywords)
        | 20 (everything else)
  score = base + 3·depth + 4·(has query) + (section ? (inside ? −20 : +15) : 0)
  ```

- `sectionPrefix(input, landing)` returns the landing path when the input URL had a path, when the redirect crossed domains, or when the path is 2+ segments deep. It returns `null` for `/`, `/index`, `/default` and `/home` (with or without an extension like `.html`), and for a shallow same-domain redirect.

## Key design decisions

| Decision | Reason |
|---|---|
| HTTP first, browser only as fallback | Most sites are server-rendered. Chromium is about 10× slower and much heavier, so it's used only when it's likely to help |
| Priority queue instead of plain BFS | With a page cap, contact/team pages must come first. Section bonus and penalty keep big multi-tenant sites focused |
| Respect robots.txt on the final host and in the browser | User decision (2026-09-29). Domains that redirect to a host disallowing generic bots report `robots-disallowed` |
| Per-server concurrency limit | Many inputs can share one server. Without the limit that server rate-limits or blocks, and sites fail |
| Soft 10-minute budget + hard 14-minute timeout | Large sites keep what they found instead of losing everything to a timeout |
| Append-only JSONL cache, kept forever | Crash-safe resume, cheap `--retry-failed` / `--summary-only`, and data for later heuristic tuning |
| One row per email per file | Aggregator sites repeat the same addresses. Output is a contact list, not a page index |
| Conservative person naming | A wrong person name is worse than a business name. Names must be consistent with the local part |

## Extending

- **New output column:** add it to `FoundOnPage`/`SiteResult` if it's per-email or per-site data, fill it in `crawler.ts`, then add it to the `rows.push` tuple and `columns` in `processFile()`. Old cache lines won't have it, so default it.
- **New email source or obfuscation:** add it in `extractFromHtml()` or `deobfuscate()`, and route every candidate through `cleanEmail()`.
- **New junk pattern:** extend `JUNK_DOMAINS`, `JUNK_LOCAL`, `BAD_TLD_SUFFIX` or `GTLDS` in `extract.ts`.
- **Crawl scope:** change `SKIP_EXT`, `SKIP_PATH`, `PRIORITY_PATH` in `urls.ts`, or the limits in `crawler.ts`.
- **New CLI flag:** parse it in `main()` and pass it into `processFile()`. Keep the rule that the CSV and summary are derived from the `done` map, so every mode produces consistent outputs.
