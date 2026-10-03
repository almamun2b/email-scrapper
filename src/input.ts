import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { baseHost, normalizeInput } from './urls.js';

export interface InputSites {
  sites: string[];
  column: number;
  header: boolean;
  invalid: number; // non-empty cells that aren't a usable URL
  duplicates: number;
}

const EXACT_HEADERS = ['website', 'url', 'domain', 'site', 'websites', 'link'];
const HEADER_WORDS = /web|url|domain|site|link/i;

/** Dedupe key: host + path + sorted query, so several dealer pages on one group domain stay separate sites. */
export function siteKey(u: string): string {
  const url = new URL(u);
  url.searchParams.sort();
  return baseHost(url.hostname) + url.pathname.replace(/\/+$/, '').toLowerCase() + (url.search ? url.search : '');
}

/**
 * Reads the website column of an input CSV. The column is the one whose header names a website/URL,
 * else the column with the most URL-like values; a first row that doesn't hold a URL there is a header.
 */
export function readSites(file: string): InputSites {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows: string[][] = parse(text, { skip_empty_lines: true, relax_column_count: true, trim: true });
  if (!rows.length) return { sites: [], column: 0, header: false, invalid: 0, duplicates: 0 };

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
  }
  return { sites, column, header, invalid, duplicates };
}
