import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Keeps the crawler on the public internet. A crawled site can redirect (or, in the browser, load
 * subresources) to localhost, the LAN or a cloud metadata address; those requests are refused.
 * SCRAPER_ALLOW_PRIVATE=1 turns the guard off (the tests serve sites from 127.0.0.1).
 */
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return !blocked.check(mapped, 'ipv4');
  const family = net.isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

const hostCache = new Map<string, Promise<boolean>>();

/**
 * Whether every address the host resolves to is public. A DNS failure counts as public: the request
 * itself then fails with the real error.
 */
export function isPublicHost(hostname: string): Promise<boolean> {
  if (process.env.SCRAPER_ALLOW_PRIVATE === '1') return Promise.resolve(true);
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return Promise.resolve(isPublicAddress(host));
  if (host === 'localhost' || host.endsWith('.localhost')) return Promise.resolve(false);
  let p = hostCache.get(host);
  if (!p) {
    p = dns.lookup(host, { all: true }).then(
      (addrs) => addrs.every((a) => isPublicAddress(a.address)),
      () => true,
    );
    hostCache.set(host, p);
  }
  return p;
}
