# AGENTS.md

Operating guide for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. For what the tool does, see [README.md](README.md). For how it's built, see [ARCHITECTURE.md](ARCHITECTURE.md).

## The recurring job

The owner regularly drops a CSV of websites into `websites/` and asks the agent to "extract emails" from it. The agent runs the scraper and reports results. Output goes to `emails/<same-file-name>.csv` with columns **`name,email,website,link`**, and a summary is appended to `emails/logs/<same-file-name>.log`.

Standard procedure:

1. Check the input: `head -5 websites/<file>.csv` and `wc -l websites/<file>.csv`. Any header named `website`/`url`/`domain`/`site`/`websites`/`link` works; otherwise the first column is used.
2. Run it in the background, because it takes about 1–2 hours per 150 sites with the default deep crawl (30–60 minutes with `--quick`):
   ```bash
   nohup npm run scrape -- websites/<file>.csv > <scratch>/run.log 2>&1 &
   ```
   Plain `npm run scrape` processes every input file that has no output yet.
3. Watch progress in the log. Each site prints `[n/N] host — X emails, Y pages …`. The run for a file ends with a `=>` line and the summary block.
4. Report per-file totals from the summary: websites with emails, websites with no emails, failed websites grouped by reason, unique emails, and name breakdown. Mention noteworthy failures.
5. If many sites fail with transient errors, offer `npm run scrape -- --retry-failed`. It re-crawls only failed sites and keeps everything else.

## Commands

| Task | Command |
|---|---|
| Install | `npm install && npx playwright install chromium` |
| Type-check (the only automated check) | `npm run typecheck` |
| Scrape new input files | `npm run scrape` |
| Scrape specific files (always re-scrapes) | `npm run scrape -- websites/a.csv` |
| Re-scrape everything | `npm run scrape -- --force` |
| Re-scrape only failed sites | `npm run scrape -- --retry-failed` |
| Rebuild CSVs and logs from cache, no network | `npm run scrape -- --summary-only` |
| Lighter, faster crawl (150 pages, 10 min/site) | `npm run scrape -- --quick` |
| Tune limits (any combination) | `--max-pages=N --browser-pages=N --max-depth=N --budget=MIN --concurrency=N --page-concurrency=N --host-concurrency=N` |

Deep crawl is the default: 400 pages, 60 browser pages, unlimited depth (`--max-depth=0`), 20 min per site. Use it for dealer, tourism and other large-site lists. Use `--quick` only when the owner wants speed over coverage. All flags are documented in README.md under "Crawl options".

There is no test suite. To test changes, use a throwaway `.mts` script (ESM, top-level `await` allowed) run with `npx tsx`, and put it outside the repo:

```ts
// scratch/check.mts
import { scrapeSite, closeBrowser } from '/abs/path/to/src/crawler.ts';
import { extractFromHtml } from '/abs/path/to/src/extract.ts';
console.log(extractFromHtml('<a href="mailto:jane@x.co.nz">Dr Jane Smith</a>'));
const r = await scrapeSite('https://lumino.co.nz/');
console.log(r.error, r.pages, r.emails);
await closeBrowser();
```

Regression baseline: `https://lumino.co.nz/` gives 6 emails with the deep defaults (3 with `QUICK_OPTIONS`), including `craig.kirkland@lumino.co.nz` named "Craig Kirkland". `https://adhb.health.nz/` gives `robots-disallowed`.

For an end-to-end check, write a 2–4 row sample CSV outside `websites/` and run `npm run scrape -- <path>`. Then **delete** the generated `emails/<sample>.csv`, `emails/.cache/<sample>.jsonl` and `emails/logs/<sample>.log`.

## Rules the owner has set

- **Output columns are exactly `name,email,website,link`.** `website` is the input URL and `link` is the page the email was found on. `name` falls back in this order: person name, then department page title, then business name.
- **Never delete `emails/.cache/`.** The owner keeps it for future improvements. Only the scraper itself resets a file's cache on a fresh `--force` scrape.
- **Don't re-scrape existing outputs unless asked.** Code changes apply to future runs; the owner decides when to re-run.
- **Respect robots.txt**, including on the host reached after a redirect and in the browser fallback. Don't add bypasses.
- **Each summary is appended** to `emails/logs/<name>.log` after every run. Keep that behaviour for any new mode.
- `websites/`, `emails/` and `logs` are git-ignored data. Never commit them.

## Process hygiene

- Long runs go in the background with `nohup … &`. Wait on the **PID** (`while kill -0 <pid>; do sleep 30; done`).
- **Never** wait with `pgrep -f` or kill with `pkill -f` using a pattern that also appears in your own shell command. It matches itself, so the wait never ends or the kill takes out your own shell. This has happened here before.
- Before starting a new run, make sure no other scrape of the same file is running. Two runs appending to one cache file will corrupt the resume logic.
- If a run is interrupted, re-running the same command resumes from the cache. Don't delete the partial cache.

## Code conventions

- ESM TypeScript run directly by `tsx`. There is no build output. Relative imports use the `.js` extension (`from './urls.js'`).
- The heuristics are tuned against real NZ healthcare sites. When changing `extract.ts` filters or name rules, re-check a few known sites and look for regressions: false person names, junk emails, lost emails.
- The CSV and the summary are always derived from `SiteResult` objects, whether fresh or cached. New fields must be optional, because old cache lines lack them.
- Keep comments sparse and explain *why*, matching the existing code.
