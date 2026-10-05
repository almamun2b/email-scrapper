/**
 * Helps maintain src/data/given-names.txt. Lists first parts of two-part local parts in the caches
 * ("firstname.lastname@…") that aren't in the list, with examples, most frequent first. Review by eye
 * and add the real given names to the file (lowercase, one per line). Writes nothing.
 *
 *   npx tsx scripts/given-names-report.ts [min-count]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'emails');
const min = Number(process.argv[2] ?? 1);
const known = new Set(fs.readFileSync(path.join(ROOT, 'src', 'data', 'given-names.txt'), 'utf8').split('\n').filter(Boolean));

const unknown = new Map<string, Set<string>>();
const caches = fs.readdirSync(OUT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(OUT_DIR, d.name, '.cache')))
  .flatMap((d) => fs.readdirSync(path.join(OUT_DIR, d.name, '.cache')).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(OUT_DIR, d.name, '.cache', f)));
for (const file of caches) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: { emails: { email: string }[] };
    try { r = JSON.parse(line); } catch { continue; }
    for (const { email } of r.emails) {
      const parts = email.split('@')[0].split(/[._-]+/).filter(Boolean);
      if (parts.length !== 2 || !parts.every((p) => /^[a-z']{3,12}$/.test(p))) continue;
      if (known.has(parts[0])) continue;
      if (!unknown.has(parts[0])) unknown.set(parts[0], new Set());
      unknown.get(parts[0])!.add(email);
    }
  }
}
const rows = [...unknown].filter(([, s]) => s.size >= min).sort((a, b) => b[1].size - a[1].size);
for (const [first, emails] of rows) console.log(`${first.padEnd(14)} ${String(emails.size).padStart(4)}  ${[...emails].slice(0, 3).join(', ')}`);
console.log(`\n${rows.length} unknown first parts (min count ${min})`);
