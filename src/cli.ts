export const BOOLEAN_FLAGS = ['force', 'retry-failed', 'retry-rate-limited', 'summary-only', 'quick', 'unique'];
export const INTEGER_FLAGS = ['max-pages', 'browser-pages', 'max-depth', 'concurrency', 'page-concurrency', 'host-concurrency'];
export const NUMBER_FLAGS = ['budget']; // minutes, may be fractional
export const OPTIONAL_NUMBER_FLAGS = ['retry-budget-queued']; // a flag that may carry minutes: --x, --x=60 or --x 60
export const RETRY_FLAGS = ['retry-failed', 'retry-rate-limited', 'retry-budget-queued'];
export const STRING_FLAGS = ['log-level'];

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
      if (raw === '' || !Number.isFinite(n) || n <= 0) throw new Error(`--${name} takes minutes > 0, got "${raw}"`);
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
  budgetMin?: number; // per-site budget for this run, from --retry-budget-queued=MIN
}

/** The retry flags of one run. `--retry-budget-queued=MIN` sets the budget, so it can't be combined with --budget. */
export function retryOptions({ flags, values }: ParsedArgs): RetryOptions {
  const budgetMin = values.get('retry-budget-queued');
  if (budgetMin !== undefined && values.has('budget')) {
    throw new Error('--retry-budget-queued=MIN and --budget=MIN both set the time budget; give it once');
  }
  return { failed: flags.has('retry-failed'), rateLimited: flags.has('retry-rate-limited'), budget: flags.has('retry-budget-queued'), budgetMin };
}

/** The raw value of one string flag, read before full validation (so logging can start first). */
export function rawFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}
