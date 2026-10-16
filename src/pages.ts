import fs from 'node:fs';
import { ensureTrailingNewline } from './cache.js';
import type { Found } from './extract.js';

/**
 * What one fetched page yielded, independent of the site that fetched it: another site of the category that
 * reaches the page again takes this instead of requesting it (a page is scraped once per category).
 */
export interface PageRecord {
  url: string; // the page's final URL after redirects
  emails: Found[];
  title?: string; // the page's <h1> or <title> as a department name, when it has a usable one
  links: string[]; // crawlable same-site links, each page once; same-origin ones as path + query, resolved against `url`
  at: number; // when the page was fetched or last revalidated (epoch ms)
  etag?: string; // validators the server gave, to revalidate the page with a conditional request
  lastModified?: string;
}

export type Mode = 'h' | 'b';
export type Loaded = { rec: PageRecord; reused: boolean } | 'gone' | null;

type Entry = { at: number; gone: true } | { at: number; gone?: false; offset: number; length: number };

const GONE_JSON = '{"gone":1}';
const CHUNK = 8 << 20;

/**
 * Every page a category has fetched, kept in `results/<category>/.cache/.pages` so all its lists and later
 * runs reuse them. A line is `<mode><key>\t<at>\t<json>`: mode `h` for pages fetched with plain HTTP, `b` for
 * the browser (it renders what HTTP can't, so the two never stand in for each other), key = pageKey(), `at` =
 * when it was fetched. The last line for a key wins, and `{"gone":1}` marks a 404/410. The file is only
 * appended to; records stay on disk and are read back on demand, so memory holds just the key index.
 * Created on the first page written.
 */
export class PageStore {
  private readonly index = new Map<string, Entry>();
  private readFd: number | null = null;
  private writeFd: number | null = null;
  private size = 0;
  private readonly inflight = new Map<string, Promise<PageRecord | null>>();
  private readonly sitemaps = new Map<string, Promise<string[]>>(); // this run only: a sitemap is a handful of requests

  constructor(private readonly file: string) {
    if (!fs.existsSync(file)) return;
    ensureTrailingNewline(file);
    this.scan();
  }

  /** Pages (and known 404s) in the store, counting each key once. */
  get pages(): number { return this.index.size; }

  /** Indexes the file: only complete lines, so a record cut off by a crash is ignored. */
  private scan(): void {
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(CHUNK);
      let carry: Buffer = Buffer.alloc(0);
      let base = 0; // file offset of carry[0]
      for (;;) {
        const n = fs.readSync(fd, buf, 0, CHUNK, base + carry.length);
        if (n === 0) break;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        let start = 0;
        for (let nl = data.indexOf(10, start); nl >= 0; nl = data.indexOf(10, start)) {
          this.indexLine(data, start, nl, base);
          start = nl + 1;
        }
        base += start;
        carry = data.subarray(start);
      }
      this.size = base + carry.length;
    } finally {
      fs.closeSync(fd);
    }
  }

  private indexLine(data: Buffer, start: number, end: number, base: number): void {
    const t1 = data.indexOf(9, start);
    if (t1 < 0 || t1 >= end) return;
    const t2 = data.indexOf(9, t1 + 1);
    if (t2 < 0 || t2 >= end) return;
    const at = Number(data.toString('latin1', t1 + 1, t2));
    if (!Number.isFinite(at)) return;
    const key = data.toString('utf8', start, t1);
    const length = end - (t2 + 1);
    if (length === GONE_JSON.length && data.toString('utf8', t2 + 1, end) === GONE_JSON) this.index.set(key, { at, gone: true });
    else this.index.set(key, { at, offset: base + t2 + 1, length });
  }

  private read(id: string): PageRecord | undefined {
    const e = this.index.get(id);
    if (!e || e.gone) return undefined;
    try {
      this.readFd ??= fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(e.length);
      fs.readSync(this.readFd, buf, 0, e.length, e.offset);
      return JSON.parse(buf.toString('utf8')) as PageRecord;
    } catch {
      this.index.delete(id); // unreadable record: fetch the page again
      return undefined;
    }
  }

  private append(id: string, at: number, json: string): void {
    this.writeFd ??= fs.openSync(this.file, 'a', 0o600);
    const head = Buffer.from(`${id}\t${at}\t`);
    const body = Buffer.from(json);
    fs.writeSync(this.writeFd, Buffer.concat([head, body, Buffer.from('\n')]));
    this.index.set(id, json === GONE_JSON ? { at, gone: true } : { at, offset: this.size + head.length, length: body.length });
    this.size += head.length + body.length + 1;
  }

  /** The stored copy of a page, whatever its age (undefined if none, or if it is a known 404). */
  get(mode: Mode, key: string): PageRecord | undefined {
    return this.read(mode + key);
  }

  /** Stores `rec`, replacing an older copy; a copy at least as new as `cutoff` stays (a landing page, requested anyway). */
  put(mode: Mode, key: string, rec: PageRecord, cutoff = Infinity): void {
    const e = this.index.get(mode + key);
    if (!e || e.at < cutoff) this.append(mode + key, rec.at, JSON.stringify(rec));
  }

  markGone(mode: Mode, key: string, at = Date.now()): void {
    this.append(mode + key, at, GONE_JSON);
  }

  /**
   * The page for `key`: from the store when its copy is not older than `cutoff`, from a fetch another site has
   * under way right now (waited for), or from `fetch`, whose result is stored. `fetch` gets the older copy of a
   * stale page, to revalidate it. `reused` says the page did not come from `fetch`. A page nobody could fetch is
   * null (sites that waited on a failed fetch try it themselves); 'gone' is a 404/410.
   */
  async load(mode: Mode, key: string, cutoff: number, fetch: (stale?: PageRecord) => Promise<PageRecord | null>): Promise<Loaded> {
    const id = mode + key;
    for (;;) {
      const e = this.index.get(id);
      if (e && e.at >= cutoff) {
        if (e.gone) return 'gone';
        const rec = this.read(id);
        if (rec) return { rec, reused: true };
        continue; // unreadable, now dropped from the index
      }
      const flying = this.inflight.get(id);
      if (!flying) break;
      const rec = await flying;
      if (rec) return { rec, reused: true };
    }
    const p = fetch(this.read(id));
    this.inflight.set(id, p.catch(() => null)); // a crash in this fetch must not reject the sites waiting on it
    try {
      const rec = await p;
      if (!rec) {
        const e = this.index.get(id);
        return e?.gone && e.at >= cutoff ? 'gone' : null;
      }
      this.append(id, rec.at, JSON.stringify(rec));
      return { rec, reused: false };
    } finally {
      this.inflight.delete(id);
    }
  }

  /** An origin's sitemap URLs, requested once per run. A load that was cut short is not kept. */
  sitemap(origin: string, load: () => Promise<string[]>, complete: () => boolean): Promise<string[]> {
    let p = this.sitemaps.get(origin);
    if (!p) {
      p = load();
      this.sitemaps.set(origin, p);
      p.then(() => { if (!complete()) this.sitemaps.delete(origin); }, () => this.sitemaps.delete(origin));
    }
    return p;
  }

  close(): void {
    for (const fd of [this.readFd, this.writeFd]) if (fd !== null) fs.closeSync(fd);
    this.readFd = this.writeFd = null;
  }
}
