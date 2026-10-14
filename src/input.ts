import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { baseHost, normalizeInput } from './urls.js';

export interface InputSites {
  sites: string[];
  column: number;
  header: boolean;
  invalid: number; // non-empty cells that aren't a usable URL
  duplicates: number;
  names: Map<string, string>; // site → the input's own business name, when the file has a name column
}

const EXACT_HEADERS = ['website', 'url', 'domain', 'site', 'websites', 'link'];
const HEADER_WORDS = /web|url|domain|site|link/i;
const NAME_HEADER = /^((business|company|organi[sz]ation|practice|clinic|church|club|dealer(ship)?|store|venue)[ _-]?)?name$/i;

/** Dedupe key: host + path + sorted query, so several dealer pages on one group domain stay separate sites. */
export function siteKey(u: string): string {
  const url = new URL(u);
  url.searchParams.sort();
  return baseHost(url.hostname) + url.pathname.replace(/\/+$/, '').toLowerCase() + (url.search ? url.search : '');
}

/** The rows of a CSV, whether saved as UTF-8 or (as Excel's "Unicode text") UTF-16 with a byte-order mark. */
function parseCsv(file: string): string[][] {
  const bytes = fs.readFileSync(file);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding).decode(bytes).replace(/^\uFEFF/, '');
  // Excel's "Unicode text" is tab-separated; a CSV re-saved as UTF-16 keeps its commas.
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0);
  const delimiter = encoding !== 'utf-8' && firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  try {
    return parse(text, { skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true, delimiter });
  } catch (err) {
    const line = (err as { lines?: number }).lines;
    throw new Error(`${file}: not a readable CSV${line ? ` (near line ${line})` : ''}: ${(err as Error).message}`);
  }
}

/**
 * Reads the website column of an input CSV. The column is the one whose header names a website/URL,
 * else the column with the most URL-like values; a first row that doesn't hold a URL there is a header.
 */
export function readSites(file: string): InputSites {
  const rows = parseCsv(file);
  if (!rows.length) return { sites: [], column: 0, header: false, invalid: 0, duplicates: 0, names: new Map() };

  const first = rows[0];
  const isUrl = (v: string | undefined) => !!v && normalizeInput(v) !== null;
  let column = first.findIndex((h) => EXACT_HEADERS.includes(h.toLowerCase()));
  if (column < 0) column = first.findIndex((h) => HEADER_WORDS.test(h) && !isUrl(h));
  if (column < 0) {
    const width = Math.max(...rows.slice(0, 200).map((r) => r.length));
    let best = -1;
    for (let c = 0; c < width; c++) {
      const n = rows.slice(0, 200).filter((r) => isUrl(r[c])).length;
      if (n > best) { best = n; column = c; }
    }
  }
  const header = !isUrl(first[column]);
  const body = header ? rows.slice(1) : rows;
  const nameCol = header ? first.findIndex((h, i) => i !== column && NAME_HEADER.test(h.trim())) : -1;
  const names = new Map<string, string>();

  const seen = new Set<string>();
  const sites: string[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const r of body) {
    const cell = r[column] ?? '';
    if (!cell) continue;
    const u = normalizeInput(cell);
    if (!u) { invalid++; continue; }
    const k = siteKey(u);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    sites.push(u);
    const name = nameCol >= 0 ? (r[nameCol] ?? '').replace(/\s+/g, ' ').trim() : '';
    if (name && name.length <= 120) names.set(u, name);
  }
  return { sites, column, header, invalid, duplicates, names };
}
