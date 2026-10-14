import { Resolver } from 'node:dns/promises';
import pLimit from 'p-limit';

/**
 * --check-mx: whether an email's domain can receive mail at all. Uses c-ares (dns.Resolver), not the libuv
 * thread pool, and asks each domain once per run.
 */
export interface MxResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

let resolver: MxResolver = new Resolver({ timeout: 5_000, tries: 2 });
const cache = new Map<string, Promise<boolean>>();
const limit = pLimit(16);

/** Tests only: replaces the resolver (null restores the system one) and forgets earlier answers. */
export function setMxResolver(r: MxResolver | null): void {
  resolver = r ?? new Resolver({ timeout: 5_000, tries: 2 });
  cache.clear();
}

// Answers that mean "this domain has no such records"; anything else (timeouts, SERVFAIL) proves nothing.
const NO_RECORDS = /^(ENOTFOUND|ENODATA)$/;
const code = (err: unknown) => String((err as { code?: string })?.code ?? '');

async function lookup(domain: string): Promise<boolean> {
  try {
    const mx = await resolver.resolveMx(domain);
    // RFC 7505: a single "." exchange says the domain accepts no mail.
    if (mx.length) return !mx.every((m) => m.exchange === '' || m.exchange === '.');
  } catch (err) {
    if (!NO_RECORDS.test(code(err))) return true;
    if (code(err) === 'ENOTFOUND') return false; // the domain doesn't exist
  }
  // No MX: mail goes to the domain's own address (RFC 5321 implicit MX), if it has one.
  for (const q of [resolver.resolve4.bind(resolver), resolver.resolve6.bind(resolver)]) {
    try {
      if ((await q(domain)).length) return true;
    } catch (err) {
      if (!NO_RECORDS.test(code(err))) return true;
    }
  }
  return false;
}

/** False only when DNS says for sure that the domain can't receive mail. */
export function canReceiveMail(domain: string): Promise<boolean> {
  const d = domain.toLowerCase();
  let p = cache.get(d);
  if (!p) {
    p = limit(() => lookup(d));
    cache.set(d, p);
  }
  return p;
}

/** The emails among `emails` whose domain can't receive mail. */
export async function undeliverable(emails: Iterable<string>): Promise<Set<string>> {
  const list = [...new Set(emails)];
  const ok = await Promise.all(list.map((e) => canReceiveMail(e.slice(e.indexOf('@') + 1))));
  return new Set(list.filter((_, i) => !ok[i]));
}
