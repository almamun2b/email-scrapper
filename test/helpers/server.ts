import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.SCRAPER_ALLOW_PRIVATE = '1';

export type Route =
  | string
  | { status?: number; type?: string; body?: string | Buffer; headers?: Record<string, string>; redirect?: string; delayMs?: number };

/** Local site for crawler tests. Unknown paths are 404s; every request path is recorded in `hits`. */
export async function startServer(routes: Record<string, Route>, host = '127.0.0.1'): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
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
    const r = routes[path];
    if (r === undefined) {
      res.statusCode = 404;
      return void res.end('not found');
    }
    const route = typeof r === 'string' ? { body: r } : r;
    if (route.delayMs) setTimeout(() => send(res, route), route.delayMs);
    else send(res, route);
  });
  await new Promise<void>((resolve) => srv.listen(0, host, resolve));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    hits,
    close: () => new Promise((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }),
  };
}

/** A page with enough visible text not to look JS-rendered. */
export function page(body: string, title = 'Acme Dental'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><p>${'Welcome to our friendly clinic. '.repeat(12)}</p>${body}</body></html>`;
}
