import dns from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import net from 'node:net';

/**
 * Keeps the crawler on the public internet. A crawled site can redirect (or, in the browser, load
 * subresources) to localhost, the LAN or a cloud metadata address; those requests are refused.
 * SCRAPER_ALLOW_PRIVATE=1 turns the guard off (the tests serve sites from 127.0.0.1).
 */
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4');
// 64:ff9b::/96 (NAT64) and 2002::/16 (6to4) embed an IPv4 address that may be a private one.
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return !blocked.check(mapped, 'ipv4');
  const family = net.isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

type Resolver = (host: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = (host) => dns.lookup(host, { all: true });
let resolver = systemResolver;

// Addresses per host, so each host is resolved once per few minutes instead of on every connection.
// Failures aren't kept: a DNS hiccup shouldn't make a host unreachable for the rest of the run.
const ADDR_TTL_MS = 10 * 60_000;
const addrCache = new Map<string, { at: number; p: Promise<LookupAddress[]> }>();

function resolve(host: string): Promise<LookupAddress[]> {
  const hit = addrCache.get(host);
  if (hit && Date.now() - hit.at < ADDR_TTL_MS) return hit.p;
  const p = resolver(host);
  addrCache.set(host, { at: Date.now(), p });
  p.catch(() => { if (addrCache.get(host)?.p === p) addrCache.delete(host); });
  return p;
}

/** Tests only: replaces the DNS resolver (null restores the system one) and forgets cached addresses. */
export function setResolver(r: Resolver | null): void {
  resolver = r ?? systemResolver;
  addrCache.clear();
}

const allowPrivate = () => process.env.SCRAPER_ALLOW_PRIVATE === '1';

/**
 * Whether every address the host resolves to is public. A DNS failure counts as public: the request
 * itself then fails with the real error.
 */
export function isPublicHost(hostname: string): Promise<boolean> {
  if (allowPrivate()) return Promise.resolve(true);
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return Promise.resolve(isPublicAddress(host));
  if (host === 'localhost' || host.endsWith('.localhost')) return Promise.resolve(false);
  return resolve(host).then((addrs) => addrs.every((a) => isPublicAddress(a.address)), () => true);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A dns.lookup replacement for the HTTP client's connections. The connection uses exactly the addresses that
 * were checked, so a host can't pass the check and then resolve to a private address on the next lookup (DNS
 * rebinding). A host with any private or local address fails with code EBLOCKED.
 */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  const host = hostname.toLowerCase();
  resolve(host).then(
    (addrs) => {
      if (!allowPrivate() && (host === 'localhost' || host.endsWith('.localhost') || !addrs.every((a) => isPublicAddress(a.address)))) {
        const err: NodeJS.ErrnoException = new Error(`${hostname} resolves to a private or local address`);
        err.code = 'EBLOCKED';
        return callback(err, '');
      }
      const list = options.family === 4 || options.family === 6 ? addrs.filter((a) => a.family === options.family) : addrs;
      if (!list.length) {
        const err: NodeJS.ErrnoException = new Error(`no IPv${options.family} address for ${hostname}`);
        err.code = 'ENOTFOUND';
        return callback(err, '');
      }
      if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    },
    (err) => callback(err, ''),
  );
}
