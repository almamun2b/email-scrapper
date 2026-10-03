# Email Scraper: Code Audit

**Date:** 2026-10-03
**Scope:** all of `src/` (`index.ts`, `crawler.ts`, `extract.ts`, `urls.ts`, `logger.ts`), `package.json`, `tsconfig.json`, and the docs (README, ARCHITECTURE, AGENTS, CLAUDE). This covers the working tree, including the uncommitted logger/concurrency changes.

## How the audit was done

- Read every source file line by line.
- `npm run typecheck` passes. `npm audit` reports 0 vulnerabilities. Node v24.18.0.
- Confirmed findings with throwaway scripts run through `npx tsx` against a local HTTP server and synthetic HTML. Every finding marked **Reproduced** was observed, not just inferred.
- Scanned the existing caches (`emails/.cache/*.jsonl`: 13 files, about 2,250 sites, **12,409 email rows**) for real-world data-quality problems.
- Checked git history: no `websites/`, `emails/` or `logs/` data has ever been committed.

## Summary

| ID | Severity | Area | Finding |
|---|---|---|---|
| H1 | High | Bug | A single link with a bad `%` escape crashes the whole site, and all of its emails are lost |
| H2 | High | Perf / DoS | Quadratic regexes can freeze the entire process for minutes or hours on one page |
| H3 | High | Data loss | Re-scraping an existing output deletes its cache first, so resume breaks and partial CSVs can follow |
| H4 | High | Data loss | `--summary-only` with no cache overwrites a good CSV with an empty one |
| H5 | High | Data quality | TLD check is too loose (ROT13 garbage passes) and too strict (`.travel`, `.cars`, `.auto` dropped) |
| M1 | Medium | Data quality | `nameFromLocal()` invents person names like "Used Cars", "Customer Relations", "Hobart Parts" |
| M2 | Medium | Data quality | `consistentPerson()` substring match accepts "Customer Care" for `gmsvcare@` |
| M3 | Medium | Bug | Browser fallback never runs for `http://` inputs |
| M4 | Medium | Resilience | A crashed or disconnected Chromium is never relaunched |
| M5 | Medium | Resilience | The hard timeout doesn't cancel the scrape, which keeps running as a zombie |
| M6 | Medium | Perf | Name lookup costs about 55 ms per email (`*:contains()` scan of the whole DOM) |
| M7 | Medium | Security | CSV formula injection through scraped business names and page titles |
| M8 | Medium | Security | Chromium runs with `--no-sandbox` on untrusted JavaScript |
| M9 | Medium | Security | Redirects can reach localhost, LAN and cloud-metadata addresses (SSRF) |
| M10 | Medium | Data loss | `--retry-failed` drops partial results and rewrites the cache non-atomically |
| M11 | Medium | Ops | No lock against two runs on the same file |
| M12 | Medium | UX | Unrecognised input headers silently yield 0 sites |
| L1–L16 | Low | Various | See [Low severity](#low-severity) |

Recommended order of work: **H1 → H2 → H3/H4 → H5 → M1/M2**, then add the [regression tests](#testing-the-biggest-gap) before tuning the heuristics further.

---

## High severity

### H1. A link with a bad `%` escape kills the whole site (Reproduced)

**Where:** [urls.ts:88](../src/urls.ts:88) `priority()` → `decodeURIComponent(url.pathname)`

The WHATWG `URL` parser leaves invalid percent sequences unchanged, so `<a href="/100%-satisfaction">` produces the pathname `/100%-satisfaction`. `decodeURIComponent` then throws `URIError: URI malformed`. `enqueue()` calls `priority()` and has no `try`. The worker loop in `crawl()` only has `try/finally`, so the exception rejects the worker, then `Promise.all(workers)`, then `crawl()` and `scrapeSite()`. `index.ts` records the site as `internal-error` with **zero emails, including those already found on the homepage**. The remaining workers keep crawling in the background.

Repro: a local server whose homepage has `mailto:info@acme.co.nz` and a link to `/100%-satisfaction`. `scrapeSite()` rejected with `URI malformed`.

None of the current caches shows `internal-error`, so this hasn't fired yet. But "100%" in a URL is a common marketing pattern, so it's waiting to happen.

**Fix:**
1. In `priority()`, wrap the decode: `let p; try { p = decodeURIComponent(url.pathname) } catch { p = url.pathname }`.
2. Defence in depth: add a `catch` in the worker loop (`crawler.ts` around line 374) that logs at debug and continues, so no single page can ever reject a whole site. Do the same around the homepage `ingest`/`enqueue` (lines 342–343).

### H2. Quadratic regexes can freeze the whole run (Reproduced)

**Where:** [extract.ts:9](../src/extract.ts:9) `EMAIL_RE`, and [extract.ts:86-87](../src/extract.ts:86) in `deobfuscate()`

- `EMAIL_RE` begins with an unbounded `[a-z0-9._%+'’-]+@`. On a long run of local-part characters with no `@`, every start position scans to the end of the run. The cost is O(n²). It runs over the **raw HTML**, including inline scripts and data blobs ([extract.ts:316-317](../src/extract.ts:316)).
- `\s*[\[\(\{<]\s*at…` has the same problem on long whitespace runs. Step 5 replaces every tag with a space, so tag-heavy pages produce exactly those runs.

Measured times for `extractFromHtml()` alone:

| Input | Size | Time |
|---|---|---|
| alphanumeric run in a `<script>` | 20 KB / 39 KB / 78 KB | 1.1 s / 4.9 s / 12.6 s |
| empty tags + whitespace | 45 KB / 90 KB / 180 KB | 4.8 s / 18.6 s / **71 s** |
| `EMAIL_RE` alone, 40 KB run | | 3.4 s |
| `deobfuscate` alone, 40 KB whitespace | | 2.8 s |

Responses are capped at 5 MB, so a single bad page can cost hours. Node is single-threaded, which makes this worse than a slow site: while the regex runs, **all 12 parallel sites stall**, and neither the per-site soft budget nor the hard timeout in `index.ts` can fire, because their timers can't run.

**Fix (any one helps; the first two together solve it):**
- Bound the local part to the RFC limit and anchor it: `(?<![a-z0-9._%+'’-])[a-z0-9._%+'’-]{1,64}@…`. Better still, find each `@` with `indexOf` and run the regex only on a window of about 64 characters before and 255 after it.
- In `deobfuscate()`, collapse whitespace first (`text.replace(/\s+/g, ' ')`, which is linear) and drop the leading `\s*` from the bracket patterns.
- Belt and braces: run extraction in a `worker_threads` pool with a per-page time limit, so pathological pages can't block the event loop.

### H3. Re-scraping deletes the cache first, so resume breaks (confirmed in code)

**Where:** [index.ts:123](../src/index.ts:123)

```ts
if (fs.existsSync(outFile) && fs.existsSync(cacheFile) && !retryFailed && !summaryOnly) fs.rmSync(cacheFile);
```

When a file that already has an output is re-scraped (`npm run scrape -- websites/x.csv` or `--force`), its cache is deleted **before** any new site has finished. Consequences:

1. **Resume doesn't work for re-scrapes.** If the run is interrupted, the old `emails/x.csv` still exists. Re-running "the same command", as README line 265 and the SIGINT message both advise, deletes the partial new cache again, and the run starts from zero every time.
2. **After an interrupted `--force`, a plain `npm run scrape` skips the file**, because the output exists. The file is left with an old CSV next to a new, partial cache.
3. A later `--summary-only` (or `--retry-failed`) on that file **overwrites the complete old CSV with a partial one**.
4. The previous run's cache, which the owner keeps for analysis ("never delete `emails/.cache/`"), is destroyed by every re-scrape.

**Fix:** rotate the cache instead of deleting it (for example, rename it to `.cache/x.<ISO-date>.jsonl`). Mark a run as in progress with a marker file (`.cache/x.inprogress`), or delete/rename the old CSV when the scrape starts. On start, if the marker exists, resume from the current cache rather than resetting it. Remove the marker after the CSV is written.

### H4. `--summary-only` without a cache writes an empty CSV over a good one

**Where:** [index.ts:119-176](../src/index.ts:119)

With `--summary-only` and no `emails/.cache/x.jsonl` (for example, the cache was lost through H3, or an output came from elsewhere), `done` is empty and `rows` is empty. `fs.writeFileSync(outFile, …)` then replaces the existing CSV with a header-only file. It also appends a "0 emails" summary.

Separately, sites that are in the input but missing from the cache are silently left out. They aren't counted as missing in the summary.

**Fix:** if the cache is missing or empty in `--summary-only` mode, log a warning and skip the file. Report "N sites not in cache" in the summary.

### H5. TLD validation is too loose and too strict at once (Reproduced on real data)

**Where:** [extract.ts:36-49](../src/extract.ts:36) `GTLDS` / `validTld()`

**Too loose: any 2-letter TLD is accepted.** Some sites obfuscate emails with ROT13. Because `.nh` and `.am` are 2 letters, the scrambled text passes `cleanEmail()` and ends up in the output as if it were a real address. The au caches contain about 20 such rows, for example:

```
vasb@onlpvglzbgbetebhc.pbz.nh   (ROT13 of info@baycity…group.com.au)
fcbegfzrq@z3pyvavp.pb.am         (ROT13 of …@m3clinic.co.nz)
media@qldairports.com.ay         (typo TLD, undeliverable)
```

**Too strict: real gTLDs outside the hand-picked list are dropped silently.** All of these return `null` today: `@rotorua.travel`, `@kiwi.cars`, `@dealer.auto`, `@shop.motors`, `@x.tours`, `@x.law`, `@b.global`, `@x.media`. These TLDs are common on exactly the dealer and tourism lists the tool now targets.

**Fix:**
- Validate against the real public suffix list. `tldts` is small, has no dependencies, and is maintained. Alternatively, embed the IANA TLD list.
- Add ROT13 recovery: if the domain's TLD is invalid but `rot13(email)` has a valid TLD and a plausible domain, keep the decoded address.
- While in this area: `JUNK_DOMAINS` contains `email.com`, which is a real consumer mail domain run by mail.com. Decide deliberately whether to keep it.

---

## Medium severity

### M1. Local-part names produce false "person" names (Reproduced on real data)

**Where:** [extract.ts:127-134](../src/extract.ts:127) `nameFromLocal()`

1,498 of the 12,409 cached rows got their person name from the email's local part. On dealer and tourism lists, many of those aren't people. The owner's rule is that a wrong person name is worse than a business name. Examples from the caches and from direct tests:

| Email local part | Name produced |
|---|---|
| `used.cars`, `spare.parts`, `body.shop`, `print.room` | Used Cars, Spare Parts, Body Shop, Print Room |
| `parts.department` | Parts Department |
| `hobart.parts`, `launceston.parts`, `devonport.parts` | Hobart Parts, … |
| `customer.relations`, `customer.experience` | Customer Relations, Customer Experience |
| `trade.res`, `diamondbeach.res` | Trade Res, Diamondbeach Res |
| `travel.carousel`, `soul.events` | Travel Carousel, Soul Events |
| `malignant.hyperthermia` | Malignant Hyperthermia |

**Fix:** the stop-list approach can't keep up with new verticals. Require the **first** part to be a known given name. A list of about 5,000 common given names (including Māori and Pacific names) is around 40 KB. Keep the stop list as a second guard, and add the dealer and tourism vocabulary: `parts`, `cars`, `customer`, `relations`, `experience`, `trade`, `res`, `events`, `travel`, `press`, `fleet`, `store`, `yard`, `shop`, plus a list of AU/NZ place names.

### M2. `consistentPerson()` matches substrings, not tokens

**Where:** [extract.ts:137-147](../src/extract.ts:137)

`words.some(w => local.includes(w))` accepts any word of 3 or more characters that appears anywhere in the local part. Real case: `gmsvcare@gm.com` was named **"Customer Care"** because `care` is a substring of `gmsvcare`. An "Ann Lee" near `annual@…` would pass the same way.

**Fix:** split the local part into tokens on `._-` and digits. Then require either a whole-token match on the first or last name, or the forms `flast`, `firstl`, `first.last` and `firstlast`. Reject names whose words are all department vocabulary (see M1).

### M3. Browser fallback never runs for `http://` inputs

**Where:** [crawler.ts:446](../src/crawler.ts:446)

`candidateStarts(site).filter(s => s.startsWith('https:'))`: for an input of `http://x.nz`, every candidate is `http:`, so the browser phase crawls nothing. A JS-rendered or emailless site then gets no Phase 2, and if Phase 1 failed it is reported as `unreachable`. None of the current inputs use `http://`, so this is latent.

**Fix:** start Phase 2 from Phase 1's landing URL (`httpOut.home.url`) when there is one, and otherwise from all candidates. That also saves re-resolving the redirect chain.

### M4. A dead Chromium is never relaunched

**Where:** [crawler.ts:183-189](../src/crawler.ts:183)

`browserPromise` is created once. If Chromium crashes or is OOM-killed mid-run, the promise still resolves to the dead `Browser`. Every later `newContext()` throws, so every remaining site that needs the fallback fails its browser phase for the rest of the run, which can last hours.

**Fix:** `browser.on('disconnected', () => { browserPromise = null })`, and retry `getBrowser()` once when `newContext()` fails.

### M5. The hard timeout abandons the scrape but doesn't stop it

**Where:** [index.ts:47-62](../src/index.ts:47)

`withTimeout` resolves with a fallback after budget + 4 min, but `scrapeSite()` keeps running. It still holds per-host and browser slots and keeps an open browser context. Meanwhile `pLimit` has already started another site, so real concurrency goes above `--concurrency`. The partial results the zombie collects are thrown away.

The sitemap loader ([crawler.ts:260](../src/crawler.ts:260)) also ignores the deadline: up to 8 sequential fetches at about 33 s worst case each, before the crawl even starts.

**Fix:** thread an `AbortSignal` through `scrapeSite → crawl → fetcher/httpGet`, abort it at the hard timeout, and return what was collected. Also check the deadline in `loadSitemapUrls`.

### M6. Name lookup scans the whole DOM once per email (Reproduced)

**Where:** [extract.ts:311](../src/extract.ts:311) `` $(`*:contains("${email}")`).last() ``

Measured on a page of about 100 KB: 0 emails took 221 ms, 50 emails took 2.97 s and 100 emails took 5.4 s, so about **55 ms per email**, all on the main thread. Staff directories with hundreds of addresses take tens of seconds of blocked event loop.

On top of that, every page is parsed by cheerio **5–6 times**: twice in `extractFromHtml`, plus `collectLinks`, `pageTitleOf`, `looksJsRendered` and `businessName`.

**Fix:** walk the text nodes once, build a `Map<email, Element>`, and look emails up in it. Parse each page once and pass the `CheerioAPI` to the helpers.

### M7. CSV formula injection

**Where:** [index.ts:173](../src/index.ts:173)

The `name` column falls back to `pageTitle` (`<h1>`/`<title>`) and `business` (`og:site_name`, JSON-LD, `<title>`), which is all text controlled by the third-party site. A site titled `=HYPERLINK("http://evil","Click")` or `=cmd|…` turns into a live formula when the CSV is opened in Excel or Google Sheets. No current cache row starts with `= + - @`, but nothing prevents it.

**Fix:** when writing the CSV, prefix any cell that starts with `=`, `+`, `-`, `@`, tab or CR with `'`. Emails and links can't start with those characters, so only `name` changes.

### M8. Headless Chromium runs without a sandbox

**Where:** [crawler.ts:187](../src/crawler.ts:187)

Playwright passes `--no-sandbox` unless `chromiumSandbox: true` is set (confirmed in `playwright-core`). The browser phase executes JavaScript from thousands of arbitrary sites, with `ignoreHTTPSErrors: true`. Without the sandbox, a renderer exploit runs code with the user's full privileges, including SSH keys, the browser profile and the repository.

**Fix:** `chromium.launch({ headless: true, chromiumSandbox: true })`. On Ubuntu 24.04 this needs unprivileged user namespaces to be allowed by AppArmor. Otherwise, run the scraper as a dedicated unprivileged user or in a container. Also set `acceptDownloads: false` on the context.

### M9. Redirects and subresources can reach internal addresses (SSRF)

**Where:** [crawler.ts:127-131](../src/crawler.ts:127) (`redirect: 'follow'`) and the browser fetcher

Links are filtered to the same site, but redirects are followed to any host. A crawled site can send the scraper to `http://127.0.0.1:…`, `http://192.168.x.x/…` or `http://169.254.169.254/` (cloud metadata), and Chromium will also load any subresource the page names. Only emails come back, so data can't easily be read out, but blind GET requests against internal services are possible. This matters most if the tool ever runs on a cloud VM or an office LAN.

**Fix:** use `redirect: 'manual'` and follow redirects yourself, resolving each hop and refusing loopback, private, link-local and CGNAT ranges. In Playwright, a `page.route` check can `abort()` the same ranges.

### M10. `--retry-failed` can lose data

**Where:** [index.ts:129-136](../src/index.ts:129)

- "Failed" means `r.error` is set, which **includes partial results** (emails found plus an error, such as a browser crash). Those emails are dropped from the cache before the retry. If the retry comes back worse, they're gone.
- `robots-disallowed` sites are re-crawled every time, although the result can't change.
- The cache is rewritten with `writeFileSync` in place. A crash mid-write truncates the only copy.

**Fix:** retry only when `error && emails.length === 0`, skip `robots-disallowed`, and keep the better of the old and new results. Write the cache to `x.jsonl.tmp`, then `rename` it, which is atomic on POSIX.

### M11. No protection against two concurrent runs

AGENTS.md warns that two runs on one file corrupt the cache, but nothing enforces it.

**Fix:** create `emails/.cache/<name>.lock` containing the PID with `fs.openSync(…, 'wx')`, delete it on exit, and treat it as stale if that PID is gone.

### M12. Unrecognised headers silently produce 0 sites

**Where:** [index.ts:27](../src/index.ts:27)

Only the exact headers `website`, `url`, `domain`, `site`, `websites` and `link` are recognised. A header such as "Website URL", "Company Website" or "Web" makes the scraper fall back to column 0, which is often the business name. Each row then fails `normalizeInput()` and is dropped without any message, and the run reports "0 sites". Even with the right column, invalid rows are skipped silently.

**Fix:** match headers by substring (`/web|url|domain|site|link/i`). Otherwise pick the column where most values parse as URLs. Log how many rows were skipped as invalid or duplicate.

---

## Low severity

| ID | Where | Finding | Suggested fix |
|---|---|---|---|
| L1 | [index.ts:187-209](../src/index.ts:187) | `--force=false` / `--quick=false` turn the flag **on**. Fractional numbers crash: `--concurrency=2.5` throws from p-limit, and `--host-concurrency=2.5` makes **every** request reject, so every site becomes `internal-error`. | Reject `=value` on boolean flags. Require integers for count flags. |
| L2 | [extract.ts:97](../src/extract.ts:97) | `NAME_WORD` is ASCII-only: "Tāne Mahuta" and "José García" are rejected. That's a notable gap for an NZ-focused tool that sees Māori names with macrons. | `/^\p{Lu}[\p{L}'’-]+\.?$/u` |
| L3 | [extract.ts:224](../src/extract.ts:224) | `cardText.split(email)`: `email` is lowercase but the page text isn't, so for `Jane.Smith@Clinic.co.nz` the "name right before the email" fallback looks at the wrong line. | Find the position case-insensitively. |
| L4 | [crawler.ts:373](../src/crawler.ts:373) | `pages++` runs before the fetch, so failed fetches count toward "pages fetched" in the summary (and toward the page budget). | Count attempts and successes separately. |
| L5 | [crawler.ts:375-383](../src/crawler.ts:375) | Pages that redirect elsewhere: the final URL is never added to `seen` (duplicate fetches). robots.txt isn't checked for the redirect target. Emails on an **off-site** redirect target (for example a group or agency site) are attributed to the input site. | `seen.add(canonical(r.url))`. Skip ingesting when `!sameSite(r.url, host)` or when robots disallows it. |
| L6 | [crawler.ts:51-65](../src/crawler.ts:51) | robots.txt: a 5xx or network failure is treated as allow-all for the whole run (RFC 9309 says to treat 5xx as disallow-all). `Crawl-delay` is ignored. robots-parser cuts the UA at the first `/`, so the token checked is `mozilla`, and site owners can't single out this bot. | Use an honest product token (for example `EmailScraperBot/1.0 (+contact)`) for robots matching. Treat 5xx as disallow. Honour `Crawl-delay` through the host limiter. |
| L7 | [crawler.ts:260-281](../src/crawler.ts:260) | Sitemaps: an invalid `<loc>` that points to a nested sitemap makes `new URL()` throw inside `hostLimit()`, which rejects the whole loader and loses **all** seeds. `.xml.gz` sitemaps are fetched but never gunzipped. | try/catch per entry. `zlib.gunzipSync` when the body starts with `1f 8b`. |
| L8 | [crawler.ts:118-163](../src/crawler.ts:118), [394-404](../src/crawler.ts:394) | DNS failures (`ENOTFOUND`) count as "network error" and are retried after 3 s, which wastes about 6–9 s plus a robots fetch per dead domain. A `www.` input never falls back to the bare domain. | Don't retry `ENOTFOUND`/`ECONNREFUSED`. Add the bare-domain variant. |
| L9 | [crawler.ts:140-156](../src/crawler.ts:140) | Non-HTML responses (PDFs, images) are downloaded in full (up to 5 MB) before `httpFetcher` checks the content type. The charset is ignored (always UTF-8), so names on windows-1252 pages come out garbled. | Check the type and cancel before reading the body. Decode with the `charset` from the header or `<meta>` (`TextDecoder` supports the common ones). |
| L10 | [crawler.ts:217-230](../src/crawler.ts:217) | The browser fetcher ingests 404/500 pages (the response status is never checked). `close()` doesn't await `context.close()`. | `if (!resp \|\| resp.status() >= 400) return null`. Await the close. |
| L11 | [crawler.ts:448-451](../src/crawler.ts:448) | If Phase 2 hits `robots-disallowed`, it `return`s early and discards Phase 1's emails. | Set the error and fall through to the normal result assembly. |
| L12 | [extract.ts:64](../src/extract.ts:64), [89-91](../src/extract.ts:89) | Dead code: `/^\d+x$/` is tested against the whole email, which contains `@`, so it never matches. The same `dot` lookbehind replace is pasted three times to handle up to three dots. | Delete the dead test. Loop until nothing changes, or use a replace callback. |
| L13 | [extract.ts:186-189](../src/extract.ts:186) | The `businessName` title fallback accepts a segment when `domainKey.includes(baseKey(seg))`, so short segments such as "NZ" or "Home" can win on matching domains. | Require `baseKey(seg).length >= 4`. |
| L14 | [index.ts:38](../src/index.ts:38), [241](../src/index.ts:241) | Input dedupe ignores the query string (`?dealer=1` and `?dealer=2` collapse). Two input files with the same basename in different folders write to the same output. | Include the query in the key, or document it. Refuse colliding basenames. |
| L15 | `package.json`, [index.ts:213-214](../src/index.ts:213) | No `engines` field, although `import.meta.dirname` needs Node 20.11 or later. A bad `--log-level` fails before file logging starts, so it never reaches `logs/error-*.log`. A missing `websites/` folder crashes with a raw stack trace. | Add `"engines": {"node": ">=20.11"}`. Init file logging before validating the other flags. Friendly error for a missing folder. |
| L16 | [crawler.ts:364](../src/crawler.ts:364) | The queue is fully re-sorted on every pop: O(n log n) per page with up to 2,000 sitemap seeds. That's fine today, but a binary heap is a 30-line change. | Min-heap. |

---

## Security and compliance

What's already good:

- No secrets in the repo. Inputs, outputs and logs are git-ignored, and the git history is clean.
- `npm audit`: 0 vulnerabilities. There are only 8 runtime dependencies, all mainstream.
- Response size cap (5 MB), timeouts on every request, a per-host concurrency cap, URL length, depth and parameter limits against crawl traps, and robots.txt honoured even after redirects.
- Logs don't contain email addresses, only counts, URLs and errors.

To fix: M7 (CSV injection), M8 (Chromium sandbox), M9 (SSRF via redirects), and L6 (honest UA / robots token).

**Legal and compliance note (not legal advice).** The output is personal information: named individuals and their work emails. In NZ, the Privacy Act 2020 applies to collecting and using it. The Unsolicited Electronic Messages Act 2007 restricts using address-harvesting software, or lists produced by it, to send unsolicited commercial messages. Australia's Spam Act 2003 has equivalent provisions, which matters because 9 of the 13 lists are AU. Make sure the downstream use is lawful (for example, messages that meet the consent rules, or non-marketing use), keep `emails/` access-controlled, and consider a retention policy for the cache. The current UA impersonates Chrome 126. An identifying UA with a contact URL is both more honest and easier to defend.

---

## Testing: the biggest gap

There are no tests, and `typecheck` is the only automated check. Yet most of the logic consists of heuristics tuned on real data, and those break silently: H5, M1 and M2 were all found only by mining the cache.

Recommendations, cheapest first:

1. **Unit tests with `node:test`** (built in, no new dependencies), run with `tsx --test`, for `cleanEmail`, `nameFromLocal`, `personName`, `consistentPerson`, `priority`, `sectionPrefix`, `canonical` and `normalizeInput`. Every example in this audit is a ready-made test case.
2. **HTML fixtures** for `extractFromHtml`: save 20–30 real contact or team pages (Cloudflare-protected, JSON-LD, staff grid, ROT13, obfuscated `[at]`) with expected `{email, name}` output.
3. **Golden cache regression:** a script that re-runs the name and filter logic over every row in `emails/.cache/*.jsonl` and diffs against the stored values. It needs no network, covers 12k real rows, and turns every heuristic change into a reviewable diff. This is how the false names in M1 were found.
4. **Performance guard:** a test that `extractFromHtml` handles a 1 MB adversarial page in under 1 s (H2, M6).
5. A minimal CI workflow (`typecheck` and `test`), and `npm test` in AGENTS.md as the standard check.

## Smaller maintainability notes

- The JSON-LD traversal is duplicated in `businessName()` and `extractFromHtml()`. Extract a shared `walkJsonLd()`.
- Consider an optional `source` field on cached emails (`mailto`, `jsonld`, `cfemail`, `text`, `raw-html`). Emails found only in raw HTML or inline scripts are the main source of junk. A source field would allow filtering or ranking them later without a re-scrape, and it stays compatible with old cache lines because it's optional.
- Add a `v` (schema version) to cache lines so that future migrations can tell old from new.
- `crawler.ts` mixes HTTP, browser, robots, sitemap and crawl-loop concerns in 480 lines. Splitting `http.ts`, `browser.ts` and `robots.ts` would make M4, M5 and M9 easier to fix.
- `--log-level` only changes the file log. The console stays at `info`. That's reasonable, but say so in `--help`/README.

## Operational observations

- `emails/.cache/au.warner-bros-movie-world.jsonl` has 187 cached sites but no CSV or summary. That looks like an interrupted run. A plain `npm run scrape` will resume it, as long as H3 doesn't bite.
- `websites/au.wet-n-wild.csv` and `websites/au.zeekr.csv` have no output yet.
- Across the caches, `unreachable` is the dominant failure (about 120 sites), followed by `robots-disallowed` (5) and one `timeout`. No `internal-error` has occurred yet (see H1).
