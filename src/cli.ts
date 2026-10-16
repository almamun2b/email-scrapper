export const BOOLEAN_FLAGS = ['force', 'retry-failed', 'retry-rate-limited', 'retry-capped', 'summary-only', 'new-only', 'quick', 'unique', 'dry-run', 'check-mx', 'help'];
export const INTEGER_FLAGS = ['max-pages', 'browser-pages', 'max-depth', 'concurrency', 'page-concurrency', 'host-concurrency'];
export const NUMBER_FLAGS = ['budget']; // minutes, may be fractional
export const OPTIONAL_NUMBER_FLAGS = ['retry-budget-queued', 'revalidate']; // a flag that may carry a number (minutes, days): --x, --x=60 or --x 60
/** Stored pages older than this many days are requested again (--revalidate=DAYS). */
export const DEFAULT_REVALIDATE_DAYS = 30;
export const RETRY_FLAGS = ['retry-failed', 'retry-rate-limited', 'retry-budget-queued', 'retry-capped'];
export const STRING_FLAGS = ['log-level'];

export const USAGE = `Usage: npm run scrape -- [options] [websites/<category>/<list>.csv ...]

With no files, scrapes every list under websites/ that has no output yet (and resumes interrupted ones).
Named files are always scraped again, unless --new-only is given.

Crawl limits (defaults: deep crawl)
  --quick                    lighter crawl: 150 pages, 30 browser pages, 10 min per site
  --max-pages=N              plain-HTTP pages per site (0 = unlimited, the default; the time budget stops the crawl)
  --browser-pages=N          headless-browser pages per site (60; 0 turns the browser off)
  --max-depth=N              click levels from the landing page (0 = unlimited)
  --budget=MIN               soft time budget per site, in minutes (20)
  --concurrency=N            sites in parallel (12)
  --page-concurrency=N       page requests in parallel within one site (3)
  --host-concurrency=N       requests in parallel to one server, across all sites (3)

Pages already scraped (kept per category in results/<category>/.cache/.pages; a page is never requested twice)
  --revalidate[=DAYS]        ask again for stored pages older than DAYS days (30); with no number, for every stored page once

Re-running and retrying (they reuse the cache and can be combined)
  --force                    scrape every list again, even those with an output
  --new-only                 keep the cache and scrape only the sites not cached yet (for a list that grew)
  --retry-failed             crawl again the sites that failed with no emails
  --retry-rate-limited       fetch the pages servers refused with HTTP 429/503
  --retry-budget-queued[=MIN]  continue sites that ran out of time, from their saved queue
  --retry-capped             continue sites that reached --max-pages (give a higher --max-pages)

Outputs without crawling
  --summary-only             rebuild CSVs and summaries from the cache with the current rules
  --unique                   each email once per category -> results/<category>/emails/unique/<category>.csv
  --check-mx                 drop emails whose domain can't receive mail (DNS lookups only)

Other
  --dry-run                  show what the command would do; writes nothing under results/
  --log-level=LEVEL          file log level: trace, debug, info, warn, error, fatal, silent (info)
  --help, -h                 this text

See README.md for details.`;

export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, number>;
  strings: Map<string, string>;
  files: string[];
}

/** Splits argv into flags and file paths. Value flags accept `--x=V` and `--x V`. Throws on anything invalid. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, number>();
  const strings = new Map<string, string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { files.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const inline = eq < 0 ? undefined : a.slice(eq + 1);
    if (BOOLEAN_FLAGS.includes(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value (got "--${name}=${inline}")`);
      flags.add(name);
    } else if (OPTIONAL_NUMBER_FLAGS.includes(name)) {
      flags.add(name);
      // a following argument is the value only if it is a number, so `--x websites/a.csv` still reads the file
      const raw = inline ?? (/^\d+(\.\d+)?$/.test(argv[i + 1] ?? '') ? argv[++i] : undefined);
      if (raw === undefined) continue;
      const n = Number(raw);
      const days = name === 'revalidate';
      if (raw === '' || !Number.isFinite(n) || n < 0 || (n === 0 && !days)) throw new Error(`--${name} takes ${days ? 'days ≥ 0' : 'minutes > 0'}, got "${raw}"`);
      values.set(name, n);
    } else if (STRING_FLAGS.includes(name)) {
      const raw = inline ?? argv[++i];
      if (!raw) throw new Error(`--${name} needs a value`);
      strings.set(name, raw);
    } else if (INTEGER_FLAGS.includes(name) || NUMBER_FLAGS.includes(name)) {
      const raw = inline ?? argv[++i];
      const n = Number(raw);
      const integer = INTEGER_FLAGS.includes(name);
      if (raw === undefined || raw === '' || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) {
        throw new Error(`--${name} needs a ${integer ? 'whole number' : 'number'} ≥ 0, got "${raw ?? ''}"`);
      }
      if (name === 'budget' && n === 0) throw new Error('--budget needs minutes > 0 (0 would stop every site after its homepage)');
      values.set(name, n);
    } else {
      throw new Error(`Unknown option: --${name}`);
    }
  }
  return { flags, values, strings, files };
}

export interface RetryOptions {
  failed: boolean; // sites that failed with no emails: crawled again from the start
  rateLimited: boolean; // pages the server refused with 429/503: fetched again
  budget: boolean; // the queue left when the time budget ran out: continued
  capped: boolean; // the queue left at the page cap: continued up to a higher --max-pages
  budgetMin?: number; // per-site budget for this run, from --retry-budget-queued=MIN
}

/** The retry flags of one run. `--retry-budget-queued=MIN` sets the budget, so it can't be combined with --budget. */
export function retryOptions({ flags, values }: ParsedArgs): RetryOptions {
  const budgetMin = values.get('retry-budget-queued');
  if (budgetMin !== undefined && values.has('budget')) {
    throw new Error('--retry-budget-queued=MIN and --budget=MIN both set the time budget; give it once');
  }
  if (flags.has('retry-capped') && !values.has('max-pages')) {
    throw new Error('--retry-capped continues sites that stopped at their page cap, so it needs a higher cap: add --max-pages=N (0 for no cap at all)');
  }
  return { failed: flags.has('retry-failed'), rateLimited: flags.has('retry-rate-limited'), budget: flags.has('retry-budget-queued'), capped: flags.has('retry-capped'), budgetMin };
}

/** The raw value of one string flag, read before full validation (so logging can start first). */
export function rawFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}
