import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino, { type Level, type LevelWithSilent } from 'pino';
import pretty from 'pino-pretty';

/**
 * Application logger.
 * - Console: human-readable (pino-pretty), info and above, keeps the familiar progress lines.
 * - Files (after initFileLogging): JSON lines in logs/, one file per day plus an error-only file.
 * Every line logged inside withLogContext() carries its fields (file, site), however deep the call.
 */

export const LOG_LEVELS: readonly LevelWithSilent[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
export const LOG_DIR = path.resolve(import.meta.dirname, '..', 'logs');

const context = new AsyncLocalStorage<Record<string, unknown>>();

const consoleStream = pretty({
  sync: true, // nothing lost when the process exits right after logging
  translateTime: 'SYS:HH:MM:ss',
  ignore: 'pid,hostname,runId',
  hideObject: true, // structured fields go to the files; the console shows the message only
  messageFormat: (log, messageKey) => {
    const msg = String(log[messageKey] ?? '');
    const err = log.err as { message?: string } | undefined;
    return err?.message && !msg.includes(err.message) ? `${msg}: ${err.message}` : msg;
  },
});

const streams = pino.multistream([{ level: 'info', stream: consoleStream }]);

export const runId = randomBytes(4).toString('hex');

export const log = pino(
  {
    level: 'info',
    base: { pid: process.pid, hostname: os.hostname(), runId },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.errWithCause },
    mixin: () => ({ ...context.getStore() }), // a copy: pino's merge strategy mutates the returned object
  },
  streams,
);

/** Runs fn with extra fields attached to every log line emitted inside it (nested contexts merge). */
export function withLogContext<T>(fields: Record<string, unknown>, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

export function parseLevel(raw: string | undefined): LevelWithSilent | undefined {
  if (raw === undefined || raw === '') return undefined;
  const l = raw.toLowerCase() as LevelWithSilent;
  if (!LOG_LEVELS.includes(l)) throw new Error(`--log-level must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
  return l;
}

/** Deletes this logger's own files older than retentionDays; never touches anything else in logs/. */
function pruneOldLogs(retentionDays: number): void {
  if (!(retentionDays > 0) || !fs.existsSync(LOG_DIR)) return;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const m = /^(?:scraper|error)-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (!m || Date.parse(m[1]) >= cutoff) continue;
    try {
      fs.rmSync(path.join(LOG_DIR, f));
    } catch (err) {
      log.warn({ err, file: f }, 'could not delete old log file');
    }
  }
}

/**
 * Adds the file streams: logs/scraper-<date>.log (everything at `level`) and logs/error-<date>.log
 * (error and fatal). Writes are synchronous so a crash or process.exit never loses the last lines.
 */
export function initFileLogging(level: LevelWithSilent = 'info'): void {
  const day = new Date().toISOString().slice(0, 10);
  const dest = (name: string) => pino.destination({ dest: path.join(LOG_DIR, `${name}-${day}.log`), sync: true, mkdir: true, append: true });
  if (level !== 'silent') streams.add({ level: level as Level, stream: dest('scraper') });
  streams.add({ level: 'error', stream: dest('error') });
  // The logger itself must pass the most verbose stream's level.
  const verbose = level === 'silent' ? 'info' : pino.levels.values[level] < pino.levels.values.info ? level : 'info';
  log.level = verbose;
  const retention = Number(process.env.LOG_RETENTION_DAYS ?? 30);
  pruneOldLogs(retention);
}

/**
 * undici (pulled in by cheerio, and then backing global fetch) can throw this assertion from a
 * socket 'end' handler when a response body is left unread. It only affects that one socket.
 */
function isUndiciParserAssertion(err: unknown): boolean {
  const e = err as { code?: string; stack?: string } | null;
  return e?.code === 'ERR_ASSERTION' && /undici[\\/]lib[\\/]dispatcher/.test(e.stack ?? '');
}

/** Logs crashes, warnings and signals; onShutdown (e.g. closing the browser) runs before a signal exit. */
export function installProcessHandlers(onShutdown: () => Promise<void>): void {
  process.on('uncaughtException', (err, origin) => {
    if (isUndiciParserAssertion(err)) {
      log.error({ err, origin }, 'undici parser assertion on a closed socket; continuing');
      return;
    }
    log.fatal({ err, origin }, 'uncaught exception, exiting');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled promise rejection, exiting');
    process.exit(1);
  });
  process.on('warning', (w) => log.warn({ err: w }, `node warning: ${w.name}`));

  let stopping = false;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(code); // second signal: don't wait for cleanup
      stopping = true;
      log.warn({ signal }, `${signal} received, shutting down (re-run the same command to resume from the cache)`);
      const timer = setTimeout(() => process.exit(code), 5_000);
      onShutdown().catch((err) => log.error({ err }, 'cleanup during shutdown failed')).finally(() => {
        clearTimeout(timer);
        process.exit(code);
      });
    });
  }
}
