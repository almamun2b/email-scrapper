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
- [Summary logs](#summary-logs)
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

Check that everything compiles:

```bash
npm run typecheck
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
- The website column is detected by header name: `website`, `url`, `domain`, `site`, `websites` or `link` (case-insensitive). If none of these headers exists, the first column is used and the first row is treated as data.
- Values may be full URLs (`https://www.example.co.nz/`) or bare domains (`example.co.nz`). `https://` is added when missing.
- Duplicate domains are ignored, including `www.` vs non-`www.` versions.
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

## Command reference

| Command | What it does |
|---|---|
| `npm run scrape` | Scrape every `websites/*.csv` that has no output in `emails/` yet |
| `npm run scrape -- websites/a.csv [b.csv …]` | Scrape specific files. This always re-scrapes, even if an output exists |
| `npm run scrape -- --force` | Re-scrape all files in `websites/` from scratch |
| `npm run scrape -- --retry-failed` | Re-scrape only sites that failed last time (unreachable, timeout, …). Successful sites are reused from the cache. Rebuilds the CSVs and logs |
| `npm run scrape -- --summary-only` | Scrape nothing. Rebuild the CSVs and summary logs from the cache |
| `npm run typecheck` | Type-check the project with `tsc --noEmit` |

Flags can be combined with file arguments, for example `npm run scrape -- websites/a.csv --retry-failed`.

Progress is printed one line per site:

```
=== nz_dentists_all: 142 sites (0 cached) ===
[37/142] lumino.co.nz — 3 emails, 150 pages (101s)
[38/142] advanced-ceramics.co.nz — 0 emails, 2 pages, browser (33s)
[39/142] adhb.health.nz — 0 emails, 0 pages, robots-disallowed (10s)
```

A full run takes roughly 30–60 minutes per 150 websites. For long runs, run it in the background:

```bash
nohup npm run scrape > scrape.log 2>&1 &
```

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
| `robots-disallowed` | The site's `robots.txt` (on the host reached after redirects) forbids crawling it |
| `timeout` | The site exceeded the hard 14-minute safety limit |

"No emails found" means the site was crawled successfully but publishes no email address. Often it only has a contact form.

## Cache and resuming

Each finished site is appended as one JSON line to `emails/.cache/<name>.jsonl`. The line holds the site URL, final URL after redirects, business name, emails with names, page titles and links, pages crawled, whether the browser was used, and any error.

- **Interrupted runs resume automatically.** Run the same command again and cached sites are skipped.
- **The cache is kept after a run.** It feeds `--retry-failed` and `--summary-only`, and is useful for later analysis.
- A fresh scrape of a file that already has an output (`--force` or an explicit file argument) starts that file's cache over.

## How it works

### 1. Crawl each website (plain HTTP first)

- Fetches the start URL and follows redirects. The host it lands on becomes the site. `www.` is ignored when comparing hosts.
- If `https://` fails, it tries `http://` and then the `www.` version.
- Uses a priority queue. Pages with paths like `contact`, `about`, `team`, `staff`, `locations`, `clinic`, … are fetched first, then the rest breadth-first.
- Seeds the queue from `sitemap.xml` (and sitemaps listed in `robots.txt`).
- Skips non-HTML files (PDFs, images, documents, media), `wp-content/uploads`, login/cart/calendar pages, and crawl traps (URLs with many query parameters, very long URLs, very deep paths).
- Limits: **150 pages per site**, 3 parallel requests per site, 15 s per request, 5 MB per page, and a 10-minute budget per site (partial results are kept).

### 2. Headless browser fallback

Chromium (via Playwright) re-crawls up to **30 pages** when:
- the plain HTTP crawl couldn't load the site at all,
- the homepage looks JavaScript-rendered (very little text without scripts), or
- the HTTP crawl found no emails.

Images, fonts and media are blocked to keep it fast.

### 3. Extract emails from every page

- `mailto:` links, including several addresses in one link and `?subject=` parameters
- Plain text and HTML-entity-encoded addresses (`&#97;&#x6b;…`)
- Cloudflare email protection (`data-cfemail`, `/cdn-cgi/l/email-protection#…`)
- Obfuscated forms: `name [at] domain [dot] co [dot] nz`, `name(at)domain.com`
- `data-email` / `data-mail` attributes and schema.org / JSON-LD `email` fields

Junk is filtered out: image names like `logo@2x.png`, placeholders (`you@example.com`, `email@domain.com`), tracking or service addresses (Sentry, Wix), hash-like local parts, and invalid TLDs.

### 4. Pick a name

1. **Person name:** from a schema.org `Person`, from `mailto:` link text, or from a nearby heading in the same "card". It must match the email: the name's words appear in the local part, as in `Jane Smith` ↔ `jsmith@`, or the name has a title such as `Dr`. As a last resort a name comes from the local part itself (`mary.jones@` → `Mary Jones`). Generic mailboxes (`info@`, `reception@`, `admin@`, …) never get a person name.
2. **Department page title:** the `<h1>` of a sub-page, used only in [section-focused crawls](#section-focused-crawling).
3. **Business name:** from JSON-LD `Organization`/`LocalBusiness`, then `og:site_name`, then the cleaned `<title>`, then the domain.

### Section-focused crawling

If the landing page has a real path, the crawl focuses on that section. This happens when the input URL has a path, when a redirect goes to another domain with a path, or when the path is two or more segments deep. For example, `adhb.health.nz` redirects to `healthnz.govt.nz/hospitals-services/hospitals/auckland/central`.

Pages under that path are fetched first, sitemap seeds are limited to that path, and emails on its sub-pages are named after the page title. Single-segment same-domain redirects like `/home` or `/en` are treated as the whole site.

### Politeness and robots.txt

- **`robots.txt` is respected**, both on the original domain and on the host reached after a redirect, and in the browser fallback. If the landing page is disallowed, the site is reported as `robots-disallowed` and nothing is extracted.
- At most **3 requests at a time to any one server** across all sites being crawled. This matters when many input domains redirect to the same server.
- HTTP 429/503 responses and network errors are retried once after 3 seconds.

## Tuning

The constants are at the top of the source files:

| Constant | File | Default | Meaning |
|---|---|---|---|
| `SITE_CONCURRENCY` | `src/index.ts` | 12 | Websites crawled in parallel |
| `SITE_TIMEOUT_MS` | `src/index.ts` | 14 min | Hard safety timeout per website |
| `budgetMs` (arg of `scrapeSite`) | `src/crawler.ts` | 10 min | Soft per-site budget; partial results are kept |
| `MAX_PAGES` | `src/crawler.ts` | 150 | Page cap per site (HTTP crawl) |
| `BROWSER_MAX_PAGES` | `src/crawler.ts` | 30 | Page cap per site (browser fallback) |
| `PAGE_CONCURRENCY` | `src/crawler.ts` | 3 | Parallel requests within one site |
| `HOST_CONCURRENCY` | `src/crawler.ts` | 3 | Parallel requests to one server across all sites |
| `HTTP_TIMEOUT` | `src/crawler.ts` | 15 s | Per-request timeout |
| `MAX_BYTES` | `src/crawler.ts` | 5 MB | Max page size |

The heuristics are all in `src/extract.ts`: junk filters, generic mailbox names, words that are never part of a person's name, and the TLD allow-list. Link priority keywords and skip rules are in `src/urls.ts`.

## Limitations

- Emails that appear only as images, or behind contact forms, logins or CAPTCHAs, can't be extracted.
- Very large sites are capped at 150 pages, so emails on deep pages can be missed. Contact-like pages are fetched first to reduce this.
- Sites whose `robots.txt` forbids generic crawlers are skipped by design.
- Name detection is heuristic. When it isn't confident, it falls back to the business name rather than guessing.
- Aggregator and government sites often list emails belonging to other organisations. Those rows are credited to the site they were found on.

## Responsible use

These are publicly published business contact details. If you use them for marketing, anti-spam law applies. In New Zealand that is the **Unsolicited Electronic Messages Act 2007**, which requires consent and a working unsubscribe option. Respect each site's terms of use.

## Project layout

```
src/
  index.ts      CLI: input discovery, per-file orchestration, cache, CSV output, summary logs
  crawler.ts    Per-site crawl: HTTP + headless-browser fallback, robots.txt, rate limiting
  extract.ts    Email extraction, junk filtering, person/business name detection
  urls.ts       URL normalisation, crawlability rules, link priority, section detection
websites/       Input CSVs (git-ignored)
emails/         Output CSVs, logs/ and .cache/ (git-ignored)
```

For internals, see [ARCHITECTURE.md](ARCHITECTURE.md).
