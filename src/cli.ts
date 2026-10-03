export const BOOLEAN_FLAGS = ['force', 'retry-failed', 'summary-only', 'quick'];
export const INTEGER_FLAGS = ['max-pages', 'browser-pages', 'max-depth', 'concurrency', 'page-concurrency', 'host-concurrency'];
export const NUMBER_FLAGS = ['budget']; // minutes, may be fractional
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

/** The raw value of one string flag, read before full validation (so logging can start first). */
export function rawFlag(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}
