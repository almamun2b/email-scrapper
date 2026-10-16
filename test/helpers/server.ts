import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.SCRAPER_ALLOW_PRIVATE = '1';

export type Route =
  | string
  | { status?: number; type?: string; body?: string | Buffer; headers?: Record<string, string>; redirect?: string; delayMs?: number };

/**
 * Local site for crawler tests. Unknown paths are 404s; every request path is recorded in `hits`, with its time in
 * `times` and its headers in `heads`. A route with an `etag` header answers 304 to a matching `If-None-Match`.
 */
export async function startServer(routes: Record<string, Route>, host = '127.0.0.1'): Promise<{ url: string; hits: string[]; times: number[]; heads: http.IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const heads: http.IncomingHttpHeaders[] = [];
  const times: number[] = []; // when each hit arrived, in the same order
  const send = (res: http.ServerResponse, route: Exclude<Route, string>) => {
    if (res.destroyed) return;
    if (route.redirect) {
      res.statusCode = route.status ?? 302;
      res.setHeader('location', route.redirect);
      return void res.end();
    }
    res.statusCode = route.status ?? 200;
    res.setHeader('content-type', route.type ?? 'text/html; charset=utf-8');
    for (const [k, v] of Object.entries(route.headers ?? {})) res.setHeader(k, v);
    res.end(route.body ?? '');
  };
  const srv = http.createServer((req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    heads.push(req.headers);
    times.push(Date.now());
    const r = routes[path];
    if (r === undefined) {
      res.statusCode = 404;
      return void res.end('not found');
    }
    const route = typeof r === 'string' ? { body: r } : r;
    const etag = route.headers?.etag;
    if (etag && req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.setHeader('etag', etag);
      return void res.end();
    }
    if (route.delayMs) setTimeout(() => send(res, route), route.delayMs);
    else send(res, route);
  });
  await new Promise<void>((resolve) => srv.listen(0, host, resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    hits,
    times,
    heads,
    close: () => new Promise((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }),
  };
}

/** A page with enough visible text not to look JS-rendered. */
export function page(body: string, title = 'Acme Dental'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><p>${'Welcome to our friendly clinic. '.repeat(12)}</p>${body}</body></html>`;
}
