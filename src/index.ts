import fs from 'node:fs';
import path from 'node:path';
import type { LevelWithSilent } from 'pino';
import { cacheFiles, LockedError } from './cache.js';
import { DEFAULT_REVALIDATE_DAYS, parseArgs, rawFlag, RETRY_FLAGS, retryOptions, suffixFilter, USAGE } from './cli.js';
import { ensureBrowser } from './browser.js';
import { closeBrowser, DEFAULT_OPTIONS, QUICK_OPTIONS, setHostConcurrency } from './crawler.js';
import { initFileLogging, installProcessHandlers, log, LOG_DIR, parseLevel, runId, withLogContext } from './logger.js';
import { categoryOf, fileLayout, findInputs, groupOf, IN_DIR, OUT_DIR, ROOT } from './paths.js';
import { describeFilter } from './filter.js';
import { closePages, describe, filteredPath, filterFile, fmtDuration, previewFile, processFile, runUnique, staleState, type RunOptions } from './run.js';

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  // File logging starts before the other flags are validated, so a bad command line is logged too.
  let level: LevelWithSilent = 'info';
  let levelError: unknown;
  try {
    level = parseLevel(rawFlag(argv, 'log-level')) ?? parseLevel(process.env.LOG_LEVEL) ?? 'info';
  } catch (err) {
    levelError = err;
  }
  initFileLogging(level);
  if (levelError) throw levelError;
  const parsed = parseArgs(argv);
  const { flags, values, files: fileArgs } = parsed;
  const force = flags.has('force');
  const retryOpts = retryOptions(parsed);
  const retry = retryOpts.failed || retryOpts.rateLimited || retryOpts.budget || retryOpts.capped ? retryOpts : null;
  const summaryOnly = flags.has('summary-only'); // rebuild CSV + summary log from the cache, no scraping
  if (summaryOnly && retry) throw new Error(`--summary-only rebuilds outputs without crawling; it can't be used with --${RETRY_FLAGS.filter((f) => flags.has(f)).join(', --')}`);
  const newOnly = flags.has('new-only'); // keep the cache, scrape only the sites in the input that aren't in it
  if (newOnly && flags.has('force')) throw new Error("--new-only keeps the cache and --force scrapes everything again; use one");
  if (newOnly && summaryOnly) throw new Error("--summary-only rebuilds outputs without crawling; it can't be used with --new-only");
  const dryRun = flags.has('dry-run');
  const filter = suffixFilter(parsed) ?? undefined; // outputs only: every email is still scraped and cached
  if (flags.has('unique')) {
    const other = ['force', 'new-only', ...RETRY_FLAGS, 'summary-only', 'quick', 'check-mx', 'revalidate', 'dry-run'].filter((f) => flags.has(f));
    if (other.length) throw new Error(`--unique only combines existing outputs; it can't be used with --${other.join(', --')}`);
    runUnique(fileArgs, filter);
    return;
  }
  const base = flags.has('quick') ? QUICK_OPTIONS : DEFAULT_OPTIONS;
  const opts: RunOptions = {
    maxPages: values.get('max-pages') ?? base.maxPages,
    browserPages: values.get('browser-pages') ?? base.browserPages,
    maxDepth: values.get('max-depth') ?? base.maxDepth,
    budgetMs: (retryOpts.budgetMin ?? values.get('budget') ?? base.budgetMs / 60_000) * 60_000,
    concurrency: Math.max(1, values.get('concurrency') ?? 12),
    pageConcurrency: Math.max(1, values.get('page-concurrency') ?? base.pageConcurrency),
    hostConcurrency: Math.max(1, values.get('host-concurrency') ?? 3),
    checkMx: flags.has('check-mx'),
    revalidateDays: flags.has('revalidate') ? values.get('revalidate') ?? 0 : DEFAULT_REVALIDATE_DAYS,
    filter,
  };
  setHostConcurrency(opts.hostConcurrency);
  log.info({ argv: process.argv.slice(2), options: opts, node: process.version, logDir: path.relative(ROOT, LOG_DIR) }, `Run ${runId} started (pid ${process.pid})`);
  if (!summaryOnly) log.info(`Crawl options: ${describe(opts)}`);
  if (filter) log.info(`Filter: ${describeFilter(filter)} (applied to the outputs, from the cache; scraping still collects every email)`);
  const files = fileArgs.map((f) => path.resolve(f));
  if (!files.length && !fs.existsSync(IN_DIR)) throw new Error(`No input files given and ${path.relative(ROOT, IN_DIR)}/ does not exist`);
  const targets = (files.length ? files : findInputs(IN_DIR)).map((f) => {
    const layout = fileLayout(groupOf(f), path.basename(f, path.extname(f)));
    return { file: f, layout };
  });
  const byOut = new Map<string, string>();
  for (const { file, layout } of targets) {
    const prev = byOut.get(layout.outFile);
    if (prev) throw new Error(`${prev} and ${file} would both write ${path.relative(ROOT, layout.outFile)}; rename one`);
    byOut.set(layout.outFile, file);
  }
  // An uncategorized list gets a folder named after it; if that name is also a category, the two share the folder.
  const categories = new Set(targets.map((t) => categoryOf(t.file)).filter(Boolean));
  for (const { file, layout } of targets) {
    if (!categoryOf(file) && categories.has(layout.group)) {
      log.warn({ input: path.relative(ROOT, file) }, `${path.basename(file)} has no category but shares results/${layout.group}/ with the "${layout.group}" category`);
    }
  }

  // The browser fallback needs Chromium; install it up front instead of failing every site that needs it.
  if (!dryRun && !summaryOnly && opts.browserPages > 0) await ensureBrowser();
  if (!dryRun) fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  let failedFiles = 0;
  // A list that isn't scraped this run still gets its filtered CSV, built from its cache.
  const skipOrFilter = async (f: string, layout: (typeof targets)[number]['layout'], why: string) => {
    if (!filter) { log.info({ input: path.relative(ROOT, f) }, why); return; }
    if (dryRun) { log.info({ input: path.relative(ROOT, f) }, `${why}; would write the filtered CSV ${path.relative(ROOT, filteredPath(layout, filter))} from its cache`); return; }
    log.info({ input: path.relative(ROOT, f) }, `${why}; writing its filtered CSV from the cache`);
    try {
      await withLogContext({ file: layout.id }, () => filterFile(f, layout, opts));
    } catch (err) {
      failedFiles++;
      if (err instanceof LockedError) log.error({ input: path.relative(ROOT, f), err }, `Skipping the filter for ${path.relative(IN_DIR, f)}: ${err.message}`);
      else log.error({ input: path.relative(ROOT, f), err }, `${path.relative(ROOT, f)} filter failed and was skipped; stack trace in logs/error-<date>.log`);
    }
  };
  for (const { file: f, layout } of targets) {
    if (!fs.existsSync(f)) { log.error({ input: f }, `Not found: ${f}`); failedFiles++; continue; }
    const interrupted = fs.existsSync(cacheFiles(layout.cacheDir, layout.base).marker);
    const hasOutput = fs.existsSync(layout.outFile);
    if (!files.length && !force && !newOnly && !retry && !summaryOnly && hasOutput && !interrupted) {
      await skipOrFilter(f, layout, `Skipping ${path.relative(IN_DIR, f)} (output exists; use --force)`);
      continue;
    }
    // A retry only redoes parts of finished scrapes; a list never scraped needs a normal run first.
    if (!files.length && retry && !hasOutput) {
      await skipOrFilter(f, layout, `Skipping ${path.relative(IN_DIR, f)} (no output yet, so nothing to retry; scrape it first)`);
      continue;
    }
    if (dryRun) {
      log.info({ input: path.relative(ROOT, f) }, previewFile(f, layout, retry, summaryOnly, newOnly, filter));
      continue;
    }
    try {
      await withLogContext({ file: layout.id }, () => processFile(f, layout, opts, retry, summaryOnly, newOnly));
    } catch (err) {
      // One unreadable or broken file never stops the others.
      failedFiles++;
      if (err instanceof LockedError) log.error({ input: path.relative(ROOT, f), err }, `Skipping ${path.relative(IN_DIR, f)}: ${err.message}`);
      else log.error({ input: path.relative(ROOT, f), err }, `${path.relative(ROOT, f)} failed and was skipped; stack trace in logs/error-<date>.log`);
    }
  }
  if (dryRun) {
    for (const line of staleState(findInputs(IN_DIR))) log.info(line);
    log.info('Dry run: nothing was scraped or written');
    return 0;
  }
  await shutdown();
  log.info({ durationMs: Date.now() - startedAt, failedFiles }, `Run ${runId} finished in ${fmtDuration(Date.now() - startedAt)}${failedFiles ? `; ${failedFiles} file(s) failed` : ''}`);
  return failedFiles ? 1 : 0;
}

const shutdown = async () => {
  closePages();
  await closeBrowser();
};
installProcessHandlers(shutdown);
main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    log.fatal({ err }, 'run failed');
    process.exit(1);
  },
);
