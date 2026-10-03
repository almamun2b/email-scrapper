# Email Scraper

Crawls every website listed in a CSV file and extracts every email address it can find. Each input file produces an output CSV with one row per unique email, plus a summary log.

```
websites/nz_dentists_all.csv   ──►   emails/nz_dentists_all.csv
(list of websites)                   (name, email, website, link)
                                     emails/logs/nz_dentists_all.log
```

Built with TypeScript on Node.js. It uses [cheerio](https://cheerio.js.org/) to parse HTML and [Playwright](https://playwright.dev/) (headless Chromium) as a fallback for JavaScript-rendered sites.

---

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Input format](#input-format)
- [Output format](#output-format)
- [Command reference](#command-reference)
- [Crawl options (depth and limits)](#crawl-options-depth-and-limits)
- [Running long jobs](#running-long-jobs)
- [Running the Australian lists](#running-the-australian-lists)
- [Summary logs](#summary-logs)
- [Diagnostic logs](#diagnostic-logs)
- [Cache and resuming](#cache-and-resuming)
- [How it works](#how-it-works)
- [Tuning](#tuning)
- [Limitations](#limitations)
- [Responsible use](#responsible-use)
- [Project layout](#project-layout)

---

## Requirements

- Node.js 20.11 or newer (uses `import.meta.dirname`; developed on v24)
- npm
- About 300 MB of disk space for Playwright's Chromium

## Installation

```bash
npm install
```

```bash
npx playwright install chromium
```

Check that everything compiles and the tests pass:

```bash
npm run typecheck
```

```bash
npm test
```

## Quick start

1. Put a CSV of websites in `websites/`, for example `websites/nz_vets.csv`:

   ```csv
   website
   https://carevets.co.nz
   vetent.co.nz
   ```

2. Run the scraper:

   ```bash
   npm run scrape
   ```

3. Collect the results from `emails/nz_vets.csv`. The summary is in `emails/logs/nz_vets.log`.

With no arguments, `npm run scrape` processes only files in `websites/` that don't have an output yet, so you can keep adding lists and re-running the same command.

## Input format

- Any `.csv` file.
- The website column is found by its header: an exact `website`, `url`, `domain`, `site`, `websites` or `link` (case-insensitive) first, then any header containing `web`, `url`, `domain`, `site` or `link` (such as `Company Website`). Failing that, the column with the most URL-like values is used, and its first row is treated as a header if it isn't a URL.
- Invalid and duplicate rows are skipped and counted in a warning. A file with no usable websites is skipped with a warning instead of producing an empty output.
- Values may be full URLs (`https://www.example.co.nz/`) or bare domains (`example.co.nz`). `https://` is added when missing. The common typo `www./example.com` is repaired. Hosts without a real domain (`www.`, `a..b.com`, an unknown TLD) are counted as invalid rows.
- Duplicate rows are ignored, including `www.` vs non-`www.` versions. Rows are compared by **domain + path + query string**, so several pages on one domain are kept as separate sites. For example, two dealers hosted on one dealer-group site (`group.com.au/ford-a`, `group.com.au/ford-b`) are crawled separately.
- A URL with a path (`https://example.org/clinics/auckland`) focuses the crawl on that section of the site. See [Section-focused crawling](#section-focused-crawling).

## Output format

`emails/<input-file-name>.csv`:

| Column | Meaning |
|---|---|
| `name` | Best name for the email, in this order: **person name** if one is clearly tied to the email, then the **department page title** (e.g. `Audiology — Auckland`), then the **business name** of the site |
| `email` | The email address, lower-cased |
| `website` | The website URL from the input CSV |
| `link` | The page the email was found on |

Example:

```csv
name,email,website,link
Craig Kirkland,craig.kirkland@lumino.co.nz,https://lumino.co.nz/,https://lumino.co.nz/start-your-lumino-journey/
Lumino The Dentists,henderson@lumino.co.nz,https://lumino.co.nz/,https://lumino.co.nz/dentists/henderson-dental-practice/
```

Rules:
- **One row per email per file.** If the same email appears on several sites, it is credited to the first site in input order.
- Rows follow the input order of the websites.
- If an email appears on several pages, `link` is the first page it was seen on. A later page wins only if it ties the email to a person name.
- A `name` that starts with `=`, `+`, `-` or `@` is prefixed with `'`, so a hostile page title can't become a live formula in Excel or Google Sheets.

## Command reference

| Command | What it does |
|---|---|
| `npm run scrape` | Scrape every `websites/*.csv` that has no output in `emails/` yet |
| `npm run scrape -- websites/a.csv [b.csv …]` | Scrape specific files. This always re-scrapes, even if an output exists |
| `npm run scrape -- --force` | Re-scrape all files in `websites/` from scratch |
| `npm run scrape -- --retry-failed` | Re-scrape only sites that failed with no emails (unreachable, timeout, …). Sites with partial results and `robots-disallowed` sites are kept. Rebuilds the CSVs and logs |
| `npm run scrape -- --summary-only` | Scrape nothing. Rebuild the CSVs and summary logs from the cache, applying the current email and name rules. Skips (and leaves untouched) a file with no cache or an interrupted scrape |
| `npm run scrape -- --quick` | Lighter, faster crawl (150 pages, 10 min per site). See [Crawl options](#crawl-options-depth-and-limits) |
| `npm run scrape -- --log-level=debug` | Also write every failed request, timeout and robots decision to `logs/`. See [Diagnostic logs](#diagnostic-logs) |
| `npm run typecheck` | Type-check the project with `tsc --noEmit` |
| `npm test` | Run the test suite (`node:test`, no network needed) |

The `--` after `npm run scrape` is required. It passes everything after it to the scraper.

Flags and file arguments can be combined in any order:

```bash
npm run scrape -- websites/a.csv --retry-failed
```

```bash
npm run scrape -- websites/a.csv websites/b.csv --max-pages=600 --budget=30
```

Unknown flags stop the run with an error, so a typo doesn't silently run with the defaults. So do `--force=false`-style values on on/off flags, and fractions where a count is expected (`--concurrency=2.5`).

Progress is printed one line per site:

```
=== nz_dentists_all: 142 sites (0 cached) ===
[37/142] lumino.co.nz — 3 emails, 150 pages (101s)
[38/142] advanced-ceramics.co.nz — 0 emails, 2 pages, browser (33s)
[39/142] adhb.health.nz — 0 emails, 0 pages, robots-disallowed (10s)
```

The first line of every run shows the crawl options in use:

```
Crawl options: 400 pages, 60 browser pages, depth unlimited, 20 min/site, 12 sites in parallel
```

## Crawl options (depth and limits)

**Deep crawl is the default.** Each website gets up to 400 pages, with no limit on depth.

**What "depth" (level) means:** depth is how many clicks a page is from the page the crawl started on:

```
level 0   dealer.com.au/                              ← start (landing) page
level 1   ├── /contact   /our-team   /used-cars       ← linked from the start page
level 2   │     └── /our-team/sales   /used-cars?page=2
level 3   │           └── /used-cars/2019-ford-ranger-12345
```

Pages listed in the site's `sitemap.xml` count as level 1.

There is **no depth limit by default**. The crawler follows links as deep as the page budget allows. Depth only affects the order pages are visited in: shallower pages go first, and contact, about, team and department pages (sales, parts, service, finance, fleet, bookings, …) go before everything else. Listing detail pages go last, because they almost never contain an email and big sites have thousands of them. Examples are car stock (`/used-cars/<car>`, `/stock/<id>`, `/new-vehicles/<model>`), offers, news, blog and event posts.

| Option | What it controls | Default (deep) | With `--quick` |
|---|---|---|---|
| `--max-pages=N` | Max page requests per site with plain HTTP (phase 1) | 400 | 150 |
| `--browser-pages=N` | Max page requests per site in the headless-browser fallback (phase 2). `0` turns the fallback off | 60 | 30 |
| `--max-depth=N` | Max click level to follow from the start page. `0` = unlimited | 0 (unlimited) | 0 (unlimited) |
| `--budget=MIN` | Soft time budget per site in minutes. When it runs out, the site stops and keeps what it found. A hard stop happens 4 minutes later, and it also keeps what was found | 20 | 10 |
| `--concurrency=N` | Websites crawled in parallel | 12 | 12 |
| `--page-concurrency=N` | Parallel page requests within one site (HTTP phase) | 3 | 3 |
| `--host-concurrency=N` | Parallel requests to one server, across all sites | 3 | 3 |
| `--quick` | Preset: the lighter limits above (this was the default before deep crawl) | — | — |

Numbers can be written as `--max-pages=600` or `--max-pages 600`. An explicit option always overrides the preset. For example, `--quick --max-pages=250` uses the quick limits but 250 pages.

When to change them:
- **Default (deep):** best for most lists, especially large sites such as car dealers, dealer groups, tourism operators and hospitals.
- **`--quick`:** small business sites such as clinics and dentists, when you want results faster.
- **`--max-pages=800 --budget=40`:** very large sites where emails are buried deep, such as big directories or council sites.
- **`--max-depth=2`:** only the start page, the pages it links to, and the pages those link to. Useful for a fast, shallow sweep of a huge list.
- **`--concurrency=6`:** a slow or unstable connection, or many sites on the same server.
- **`--concurrency=24 --page-concurrency=4 --host-concurrency=4`:** a faster run on a good connection. Total requests in flight are at most `concurrency × page-concurrency`, and no single server gets more than `host-concurrency`. Raise the per-server number slowly: servers that see too many requests rate-limit or block.

### Is a high concurrency setting safe?

The most aggressive setting you might use is `--concurrency=24 --page-concurrency=4 --host-concurrency=4`. It is safe for your data and your machine, but it is more aggressive than most runs need. It is not recommended as a first run.

**What can't go wrong**
- Nothing is lost if it overloads. Each finished site is saved to the cache, and `--retry-failed` redoes the failures.
- Memory stays bounded. Browser pages are capped at 4 at once, whatever the other numbers are.
- It respects `robots.txt`, and 4 requests at a time to one server is gentle for any single host.

**What can go wrong**
- The peak is `concurrency × page-concurrency`, which is 24 × 4 = 96 requests in flight at once. Home routers, VPNs and Wi-Fi often struggle past roughly 50–100. That shows up as spurious `unreachable` or `timeout` failures and slower crawls.
- The per-server cap counts hostnames, not shared platforms. Hundreds of dealer sites run on the same platforms and CDNs, so those providers can still see a burst. Some rate-limit or block it, and blocked sites then look like "no emails found".
- Heavily loaded sites hit the per-site budget (`--budget`, 20 minutes by default) sooner and return partial results, so you can get fewer emails.

**Recommended approach:** start with a moderate setting and watch the first file's failure counts in `emails/logs/<name>.log`. Raise the numbers only if the failures stay low.

```bash
npm run scrape -- --concurrency=16 --page-concurrency=3 --host-concurrency=3
```

If failures are high, lower the numbers, or run `--retry-failed` afterwards.

Examples:

```bash
npm run scrape -- websites/au.toyota.csv
```

```bash
npm run scrape -- websites/nz_dentists_all.csv --quick
```

```bash
npm run scrape -- websites/big.csv --max-pages=800 --budget=40
```

```bash
npm run scrape -- websites/huge.csv --max-depth=2 --concurrency=16
```

The options used are also written into each summary in `emails/logs/<name>.log`, so you can see how every run was configured.

## Running long jobs

Rough timings for 150 websites: about 30–60 minutes with `--quick`, and about 1–2 hours with the default deep crawl. Run long jobs in the background so they survive closing the terminal:

```bash
mkdir -p logs && nohup npm run scrape -- websites/au.toyota.csv > logs/run.log 2>&1 &
```

```bash
echo $!
```

`$!` prints the PID of the job you just started. Follow progress (Ctrl+C stops watching, not the scrape):

```bash
tail -f logs/run.log
```

Check whether it is still running (replace `12345` with the PID):

```bash
kill -0 12345 && echo running || echo finished
```

Stop it (the cache keeps every site that already finished). `$!` is the PID of `npm`, and npm does not pass the signal on to the scraper, so stop the scraper process itself. Its PID is printed in the first line of the log: `Run 6696978c started (pid 23456)`.

```bash
kill 23456
```

The scraper logs `SIGTERM received, shutting down`, closes the headless browser and exits. Stopping only the `npm` PID leaves the scraper running in the background.

**Resume** after a stop, crash or reboot: run the same command again, or a plain `npm run scrape`. Sites already in `emails/.cache/<name>.jsonl` are skipped. This also works for an interrupted re-scrape (`--force` or an explicit file). Two runs can't work on the same file at once: the second one skips it with an error (see [Cache and resuming](#cache-and-resuming)).

After a run finishes:
- `emails/<name>.csv` holds the results.
- `emails/logs/<name>.log` holds the summary: websites with emails, failures by reason, unique emails, and name breakdown.
- `logs/error-<date>.log` lists every error from the run with its stack trace. If it's empty, nothing went wrong internally. See [Diagnostic logs](#diagnostic-logs).
- If many sites failed with `unreachable` or `timeout` (often network hiccups), run `npm run scrape -- websites/<name>.csv --retry-failed`.
- If failures read `browserType.launch: Executable doesn't exist …`, Playwright's Chromium isn't installed, or doesn't match the installed Playwright version. Every site that needs the browser fallback then fails. Fix it with the command below, then rerun with `--retry-failed`:

  ```bash
  npx playwright install chromium
  ```

## Running the Australian lists

The `websites/au.*.csv` files list Australian car dealers by brand and businesses connected with the Gold Coast theme parks:

| File | Contents |
|---|---|
| `au.toyota.csv`, `au.ford.csv`, `au.mazda.csv`, `au.kia.csv`, `au.byd.csv`, `au.gwm.csv`, `au.gm.csv`, `au.zeekr.csv` | Brand's official AU site + dealers (own domains, or dealer pages on group sites) + related brand businesses |
| `au.warner-bros-movie-world.csv`, `au.dreamworld.csv`, `au.wet-n-wild.csv` | Official park sites + sister parks + ticket resellers, tours, transfers, hotels and travel agents |

Run all of them in the background with the default deep crawl. Each file is processed in turn and gets its own output and log:

```bash
mkdir -p logs && nohup npm run scrape -- websites/au.*.csv > logs/au-run.log 2>&1 &
```

Or run one list at a time:

```bash
npm run scrape -- websites/au.toyota.csv
```

Afterwards, retry the sites that failed. The `--retry-failed` run keeps everything else:

```bash
npm run scrape -- websites/au.*.csv --retry-failed
```

Rebuild the CSVs and logs from the cache without touching the network:

```bash
npm run scrape -- websites/au.*.csv --summary-only
```

Note that `npm run scrape -- websites/au.*.csv` always re-scrapes the files named. A plain `npm run scrape` would also pick up any `websites/*.csv` that has no output yet. Dealer sites are big, so expect roughly 1–2 hours per 150 sites with the default deep crawl. For a faster first pass, add `--quick`.

## Summary logs

After each CSV is processed, a summary is printed and **appended** to `emails/logs/<name>.log`. The file keeps a history of every run.

```
[2026-09-29 13:49:30] nz_veterinarians_all.csv  (scrape, took 38m 12s)
  Websites : 72 total | 53 with emails | 14 no emails found | 5 failed
  Emails   : 241 unique (51 person name, 0 department page title, 190 business name)
  Crawl    : 3919 pages fetched | headless browser used on 17 sites
  Failures : unreachable=5
  Top sites: vetent.co.nz (25), myfarmfirst.co.nz (24), carevets.co.nz (23), ...
  Failed sites:
    - clivevets.co.nz [unreachable]
  No emails found on:
    - anexa.co.nz
```

Failure reasons:

| Reason | Meaning |
|---|---|
| `unreachable` | The site didn't respond (DNS failure, connection refused, TLS error, or every start URL failed) |
| `robots-disallowed` | The site's `robots.txt` (on the host reached after redirects) forbids crawling it, or answers with a server error (5xx), which the robots.txt standard treats as "keep out" |
| `timeout` | The site exceeded the hard safety limit (the `--budget` plus 4 minutes; 24 minutes by default). It was stopped, and whatever it found by then is kept |
| `browser-error` | The headless browser crashed or couldn't start on this site. Plain-HTTP results, if any, are kept. The details are in `logs/error-<date>.log` |
| `internal-error` | The scraper itself crashed on this site. The stack trace is in `logs/error-<date>.log` |
| `other` | (Summary counts only) an older cache line whose failure was stored as raw error text. The text is listed under "Failed sites" |

"No emails found" means the site was crawled successfully but publishes no email address. Often it only has a contact form.

A `Limited : N page(s) skipped on M site(s) …` line means those servers answered HTTP 429 (Too Many Requests) or 503 (Service Unavailable) even after one retry, so those pages were skipped. The busiest servers are listed. A few is normal. If it's large, re-scrape that file with fewer parallel requests (`--host-concurrency=2`, or `--concurrency=6`). `--retry-failed` only redoes sites that ended with no emails, so it won't fill in pages skipped on sites that did return some. The per-site progress line also shows `N pages rate-limited`.

## Diagnostic logs

Besides the per-file summaries, every run writes structured diagnostic logs with [pino](https://getpino.io) to the root `logs/` folder (git-ignored):

| File | Contents |
|---|---|
| `logs/scraper-YYYY-MM-DD.log` | Every event at or above the log level (default `info`): run start and options, each file, each finished site with its counts and timing, warnings, errors |
| `logs/error-YYYY-MM-DD.log` | Only `error` and `fatal` events, with full stack traces. Check this first after a run |

- **Format:** one JSON object per line. Every line has `time`, `level` (`20` debug, `30` info, `40` warn, `50` error, `60` fatal), `msg` and `runId`. That makes it easy to separate overlapping runs. Lines logged while a file or site is being processed also carry `file` and `site`.
- **Rotation and retention:** a new file is started for each day, named by the run's start date. Files older than 30 days are deleted at startup. Change the period with `LOG_RETENTION_DAYS=N`; `0` keeps them forever. Only `scraper-*.log` and `error-*.log` are ever deleted, so your own `logs/run.log` from `nohup` is safe.
- **Writes are synchronous,** so the last lines before a crash or `kill` are never lost.
- **The terminal** shows a readable version of `info` and above: the usual `[n/N] host — …` progress lines, with warnings and errors highlighted. `--log-level` only changes the file log; the terminal always shows `info` and above. Each terminal line about a site starts with `[host]` and ends with the URL involved, when the message doesn't already say them: `[aolimo.com.au] request failed — https://aolimo.com.au/contact`.

### Log levels

`--log-level=<level>` (or the `LOG_LEVEL` environment variable; the flag wins) sets what goes into `scraper-*.log`. The levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal` and `silent`.

| Level | What is logged |
|---|---|
| `info` (default) | Run/file/site progress, robots.txt blocks, sites that ran out of time budget |
| `warn` | Sites that failed with no emails; the first page each server refused with 429/503 after a retry (the rest are counted in the summary); a server dropping a connection mid-response (once per site); hard timeouts; skipped input rows; unreadable cache lines; SIGINT/SIGTERM |
| `error` | The headless browser failing on a site or failing to start, a site crashing the scraper, a file skipped because another run holds it |
| `fatal` | Uncaught exceptions and unhandled rejections; the process exits with code 1 |
| `debug` | Every non-200 response, every rate-limited page after the first per server, network error (with its `ECONNRESET`/`ENOTFOUND` code), request timeout, oversize page, failed browser page, sitemap failure, refused private address and skipped off-site redirect. Verbose: use it to investigate a specific site |

### Reading the logs

```bash
npx pino-pretty < logs/scraper-2026-10-03.log
```

```bash
jq -c 'select(.level >= 40) | {time, site, msg, err: .err.message}' logs/scraper-2026-10-03.log
```

```bash
jq -c 'select(.site == "https://example.co.nz/")' logs/scraper-2026-10-03.log
```

## Cache and resuming

Each finished site is appended as one JSON line to `emails/.cache/<name>.jsonl`. The line holds the site URL, final URL after redirects, business name, emails with names, page titles, links and where each email was found (`source`), pages fetched, whether the browser was used, and any error.

Files in `emails/.cache/` for each input `<name>`:

| File | Meaning |
|---|---|
| `<name>.jsonl` | The cache the scraper reads and appends to |
| `<name>.inprogress` | A scrape of this file started and hasn't written its CSV yet. The next run resumes instead of starting over |
| `<name>.lock` | Holds the PID of the run working on this file. A second run skips the file with an error. A lock left by a process that no longer exists is taken over automatically |
| `<name>.<YYYYMMDD-HHMMSS>.jsonl` | An earlier run's cache, renamed aside (timestamp in UTC) when the file was scraped again from scratch. Never deleted |

- **Interrupted runs resume automatically,** including interrupted `--force` and explicit-file re-scrapes. Run the same command again (or a plain `npm run scrape`) and cached sites are skipped.
- **A fresh re-scrape keeps the old cache.** When a file with an existing output is scraped again (`--force` or an explicit file argument), its cache is renamed to `<name>.<timestamp>.jsonl` and a new one is started.
- **Outputs always use the current rules.** The CSV and summary re-apply the current email checks and name rules to every cached row, so after an update `--summary-only` cleans old outputs without re-scraping. The cache files themselves are never rewritten (except by `--retry-failed`, which drops the failed sites it is about to redo, via an atomic rename).

## How it works

### 1. Crawl each website (plain HTTP first)

- Fetches the start URL and follows redirects. The host it lands on becomes the site. `www.` is ignored when comparing hosts.
- If `https://` fails, it tries `http://` and then the `www.` version (or the bare domain for a `www.` input). Domains that don't resolve are not retried.
- Uses a priority queue. Pages with paths like `contact`, `about`, `team`, `staff`, `locations`, `clinic`, … are fetched first, then the rest breadth-first.
- Seeds the queue from `sitemap.xml` (and sitemaps listed in `robots.txt`).
- Skips non-HTML files (PDFs, images, documents, media), `wp-content/uploads`, login/cart/calendar pages, and crawl traps (URLs with many query parameters, very long URLs, very deep paths). Non-HTML responses are recognised by their `Content-Type` and never downloaded.
- Follows redirects itself. A page that redirects to another site, or into a path `robots.txt` disallows, is skipped. Gzipped sitemaps are supported.
- Decodes pages in their declared charset (header or `<meta charset>`), so names on older `windows-1252` sites come out right.
- Listing detail pages (car stock, offers, news and blog posts) are fetched last, and stock/product sitemaps are read after page sitemaps.
- Limits (defaults, see [Crawl options](#crawl-options-depth-and-limits)): **400 pages per site**, unlimited depth, 3 parallel requests per site, 15 s per request, 5 MB per page, and a 20-minute budget per site (partial results are kept).

### 2. Headless browser fallback

Chromium (via Playwright) re-crawls up to **60 pages** (`--browser-pages`), starting from the page Phase 1 landed on, when:
- the plain HTTP crawl couldn't load the site at all,
- the homepage looks JavaScript-rendered (very little text without scripts), or
- the HTTP crawl found no emails.

Images, fonts and media are blocked to keep it fast. If Chromium crashes, the next site starts a new one.

**Headless browser sandbox.** Chromium runs with its sandbox on, because it executes JavaScript from thousands of unknown sites. On Linux that needs unprivileged user namespaces. If the browser fails to start with a sandbox or namespace error (some hardened Ubuntu setups), either allow them for Playwright's Chromium (on Ubuntu 23.10+ that means an AppArmor profile for the Chromium binary), run the scraper in a container, or, accepting the risk, run with `SCRAPER_NO_SANDBOX=1`.

### 3. Extract emails from every page

- `mailto:` links, including several addresses in one link and `?subject=` parameters
- Plain text and HTML-entity-encoded addresses (`&#97;&#x6b;…`)
- Cloudflare email protection (`data-cfemail`, `/cdn-cgi/l/email-protection#…`)
- Obfuscated forms: `name [at] domain [dot] co [dot] nz`, `name(at)domain.com`, and ROT13-scrambled addresses (`vasb@rknzcyr.pbz.nh` → `info@example.com.au`)
- `data-email` / `data-mail` attributes and schema.org / JSON-LD `email` fields

Junk is filtered out: image names like `logo@2x.png`, placeholders (`you@example.com`, `email@domain.com`), tracking or service addresses (Sentry, Wix), hash-like local parts, and domains that aren't under a real public suffix (checked against the Public Suffix List with `tldts`, so `.travel` or `.auto` pass and `.ay` doesn't).

### 4. Pick a name

1. **Person name:** from a schema.org `Person`, from `mailto:` link text, or from a nearby heading in the same "card". It must match the email by whole words: a name word equals a part of the local part, or the local part is a usual form like `jsmith`, `janes` or `smithj` for `Jane Smith`, or the name has a title such as `Dr`. Names made only of department words (`Customer Care`) never count. As a last resort a name comes from the local part itself (`mary.jones@` → `Mary Jones`), but only when its first part is a known given name (`src/data/given-names.txt`) and no part is a department word. So `used.cars@` or `customer.relations@` get the business name instead. When one first part appears with five or more different second parts on one site (`bec.brisbane@`, `bec.cairns@`, …), those are branch mailboxes, not people. Generic mailboxes (`info@`, `reception@`, `admin@`, …) never get a person name.
2. **Department page title:** the `<h1>` of a sub-page, used only in [section-focused crawls](#section-focused-crawling).
3. **Business name:** from JSON-LD `Organization`/`LocalBusiness`, then `og:site_name`, then the cleaned `<title>`, then the domain.

### Section-focused crawling

If the landing page has a real path, the crawl focuses on that section. This happens when the input URL has a path, when a redirect goes to another domain with a path, or when the path is two or more segments deep. For example, `adhb.health.nz` redirects to `healthnz.govt.nz/hospitals-services/hospitals/auckland/central`.

Pages under that path are fetched first, sitemap seeds are limited to that path, and emails on its sub-pages are named after the page title. Single-segment same-domain redirects like `/home` or `/en` are treated as the whole site.

### Politeness and robots.txt

- **`robots.txt` is respected**, both on the original domain and on the host reached after a redirect, and in the browser fallback. If the landing page is disallowed, the site is reported as `robots-disallowed` and nothing is extracted. A `robots.txt` that answers with a server error (5xx, after one retry) counts as "disallow everything".
- **`Crawl-delay` is honoured** (capped at 10 seconds), as a minimum gap between requests to that server.
- At most **3 requests at a time to any one server** across all sites being crawled. This matters when many input domains redirect to the same server.
- HTTP 429/503 responses and transient network errors are retried once, after the server's `Retry-After` (1–30 s) or 3 seconds. A page still refused is skipped and counted (see `Limited` in [Summary logs](#summary-logs)).
- **Only public addresses are fetched.** Redirects (and, in the browser, any request) to localhost, private networks or cloud metadata addresses are refused.

## Tuning

Most limits are command-line options; see [Crawl options](#crawl-options-depth-and-limits). Their defaults are `DEFAULT_OPTIONS` and `QUICK_OPTIONS` in `src/crawler.ts`. The remaining constants are at the top of the source files:

| Constant | File | Default | Meaning |
|---|---|---|---|
| `DEFAULT_OPTIONS` / `QUICK_OPTIONS` | `src/crawler.ts` | 400/60/unlimited/20 min · 150/30/unlimited/10 min | Pages, browser pages, max depth, soft budget |
| `HARD_TIMEOUT_EXTRA_MS` | `src/index.ts` | 4 min | Hard safety timeout per site = budget + this |
| `STOP_GRACE_MS` | `src/index.ts` | 30 s | After the hard timeout, how long a site gets to return its partial results |
| `HTTP_TIMEOUT` | `src/http.ts` | 15 s | Per-request timeout |
| `MAX_BYTES` | `src/http.ts` | 5 MB | Max page size |

The heuristics are all in `src/extract.ts`: junk filters, generic mailbox names, words that are never part of a person's name (`DEPT_WORDS`), and the given-name list in `src/data/given-names.txt`.

After changing them, check the effect on everything scraped so far (reads the caches, writes nothing):

```bash
npx tsx scripts/recheck-cache.ts
```

To find given names missing from the list, review the first parts of `first.last@` addresses that aren't in it:

```bash
npx tsx scripts/given-names-report.ts 2
``` Link priority keywords (`PRIORITY_PATH`), the listing-page penalty (`LISTING_SEGMENT`) and skip rules are in `src/urls.ts`.

## Limitations

- Emails that appear only as images, or behind contact forms, logins or CAPTCHAs, can't be extracted.
- Very large sites are capped at 400 pages (`--max-pages`), so emails on deep pages can be missed. Contact-like pages are fetched first and listing pages last to reduce this.
- Sites whose `robots.txt` forbids generic crawlers are skipped by design.
- Name detection is heuristic. When it isn't confident, it falls back to the business name rather than guessing. People whose first name isn't in the given-name list only get a person name when the page itself ties the name to the email.
- Aggregator and government sites often list emails belonging to other organisations. Those rows are credited to the site they were found on.

## Responsible use

These are publicly published business contact details. If you use them for marketing, anti-spam law applies. In New Zealand that is the **Unsolicited Electronic Messages Act 2007**, and in Australia the **Spam Act 2003**. Both require consent and a working unsubscribe option. Respect each site's terms of use.

## Project layout

```
src/
  index.ts      CLI entry: per-file orchestration, hard timeouts, CSV output, summary logs
  cli.ts        Command-line parsing and validation
  input.ts      Reading the website column of an input CSV
  cache.ts      Cache file, resume marker, rotation and per-file lock
  output.ts     CSV rows, formula-safe cells, re-checking cached results
  logger.ts     pino logger: console + logs/*.log JSON files, per-site context, crash/signal handlers
  crawler.ts    Per-site crawl: page queue, HTTP phase, headless-browser phase
  http.ts       HTTP GET: redirects, per-server limits, Crawl-delay, retries, charset decoding
  browser.ts    Shared sandboxed Chromium and the browser page fetcher
  robots.ts     robots.txt loading and checks
  sitemap.ts    Sitemap seeding (including .xml.gz)
  netguard.ts   Refuses private, loopback and metadata addresses
  extract.ts    Email extraction, junk filtering, person/business name detection
  urls.ts       URL normalisation, crawlability rules, link priority, section detection
  data/         given-names.txt
test/           node:test suites and a local test server (npm test)
scripts/        recheck-cache.ts, given-names-report.ts
websites/       Input CSVs (git-ignored)
emails/         Output CSVs, logs/ and .cache/ (git-ignored)
logs/           Diagnostic JSON logs: scraper-<date>.log, error-<date>.log (git-ignored)
```

For internals, see [ARCHITECTURE.md](ARCHITECTURE.md).
