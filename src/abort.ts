/**
 * Settles like `p`, except that it resolves with `fallback` as soon as `signal` aborts. Used for waits that can't
 * be cancelled themselves (a queued p-limit slot): `p` still runs and settles on its own, but nobody waits for it.
 */
export function untilAborted<T, F>(p: Promise<T>, signal: AbortSignal | undefined, fallback: F): Promise<T | F> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.resolve(fallback);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(fallback);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}
