import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const IN_DIR = path.join(ROOT, 'websites');
export const OUT_DIR = path.join(ROOT, 'emails');

/** Everything one input file writes. `id` (`dealers/au.ford`) names it in messages and logs. */
export interface FileLayout {
  id: string;
  group: string;
  base: string;
  groupDir: string;
  emailsDir: string;
  outFile: string;
  cacheDir: string;
  logDir: string;
  uniqueDir: string;
}

/** Folder inside a group that holds its output CSVs (emails/<group>/emails/*.csv). */
const EMAILS_SUBDIR = 'emails';

const baseName = (f: string) => path.basename(f, path.extname(f));

/** The single folder name of `file` directly inside `dir`, or undefined if it isn't exactly one level down. */
function folderIn(dir: string, file: string): string | undefined {
  const rel = path.relative(dir, path.dirname(path.resolve(file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return undefined;
  return rel;
}

/** The category of an input or output CSV: its folder under websites/ (websites/<category>/x.csv) or emails/ (emails/<category>/emails/x.csv), else undefined. */
export function categoryOf(file: string, inDir = IN_DIR, outDir = OUT_DIR): string | undefined {
  const rel = path.relative(outDir, path.dirname(path.resolve(file))).split(path.sep);
  const fromOutput = rel.length === 2 && rel[1] === EMAILS_SUBDIR && rel[0] && rel[0] !== '..' && rel[0] !== '.' ? rel[0] : undefined;
  return folderIn(inDir, file) ?? fromOutput;
}

/** The emails/<group>/ folder for a CSV: its category, else its own base name, so an uncategorized list gets a folder to itself. */
export function groupOf(file: string, inDir = IN_DIR, outDir = OUT_DIR): string {
  return categoryOf(file, inDir, outDir) ?? baseName(file);
}

export function fileLayout(group: string, base: string, outDir = OUT_DIR): FileLayout {
  const groupDir = path.join(outDir, group);
  const emailsDir = path.join(groupDir, EMAILS_SUBDIR);
  return {
    id: `${group}/${base}`,
    group,
    base,
    groupDir,
    emailsDir,
    outFile: path.join(emailsDir, `${base}.csv`),
    cacheDir: path.join(groupDir, '.cache'),
    logDir: path.join(groupDir, 'logs'),
    uniqueDir: path.join(groupDir, 'unique'),
  };
}

const isCsv = (e: fs.Dirent) => e.isFile() && e.name.toLowerCase().endsWith('.csv');

/** Input lists: websites/*.csv (uncategorized) and websites/<category>/*.csv, sorted. */
export function findInputs(inDir = IN_DIR): string[] {
  if (!fs.existsSync(inDir)) return [];
  const files: string[] = [];
  for (const e of fs.readdirSync(inDir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (isCsv(e)) files.push(path.join(inDir, e.name));
    else if (e.isDirectory()) {
      for (const f of fs.readdirSync(path.join(inDir, e.name), { withFileTypes: true })) {
        if (!f.name.startsWith('.') && isCsv(f)) files.push(path.join(inDir, e.name, f.name));
      }
    }
  }
  return files.sort();
}

/** Output CSVs per group folder (emails/<group>/emails/*.csv); the cross-group emails/unique/ and emails/logs/ are not groups. */
export function findOutputs(outDir = OUT_DIR): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  if (!fs.existsSync(outDir)) return groups;
  for (const e of fs.readdirSync(outDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'unique' || e.name === 'logs') continue;
    const dir = path.join(outDir, e.name, EMAILS_SUBDIR);
    if (!fs.existsSync(dir)) continue;
    const csvs = fs.readdirSync(dir, { withFileTypes: true }).filter(isCsv).map((f) => path.join(dir, f.name)).sort();
    if (csvs.length) groups.set(e.name, csvs);
  }
  return groups;
}
