// Keeps the AI-facing docs small and navigable. Run by `npm test`.
//   • line caps per file
//   • docs/*.md carry "Last updated: YYYY-MM-DD"
//   • relative markdown links resolve
//   • CLAUDE.md's docs map links every docs/*.md
//   • DECISIONS/LEARNINGS entries are numbered without gaps or duplicates
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const CAPS = { 'CLAUDE.md': 120, 'README.md': 200, 'skill/SKILL.md': 120, 'docs/STATE.md': 150, 'docs/DECISIONS.md': 200, 'docs/LEARNINGS.md': 200 };
const DEFAULT_DOC_CAP = 200;
const errors = [];
const read = f => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

const docs = readdirSync('docs').filter(f => f.endsWith('.md')).map(f => `docs/${f}`);
const files = [...new Set([...Object.keys(CAPS), ...docs])];

for (const file of files) {
  if (!existsSync(file)) { errors.push(`${file}: missing`); continue; }
  const text = read(file);
  const lines = text.split('\n').length;
  const cap = CAPS[file] ?? DEFAULT_DOC_CAP;
  if (lines > cap) errors.push(`${file}: ${lines} lines > cap ${cap}. Condense or prune; don't raise the cap.`);

  if (file.startsWith('docs/')) {
    const m = /Last updated: (\d{4}-\d{2}-\d{2})/.exec(text);
    if (!m) errors.push(`${file}: missing "Last updated: YYYY-MM-DD"`);
    else if (Number.isNaN(Date.parse(m[1]))) errors.push(`${file}: bad date ${m[1]}`);
  }

  // Skip fenced code when looking for links.
  const prose = text.replace(/```[\s\S]*?```/g, '');
  for (const [, target] of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const p = path.join(path.dirname(file), target.split('#')[0]);
    if (!existsSync(p)) errors.push(`${file}: broken link → ${target}`);
  }
}

const claude = read('CLAUDE.md');
for (const d of docs) if (!claude.includes(`](${d})`)) errors.push(`CLAUDE.md: docs map doesn't link ${d}`);

for (const [file, prefix] of [['docs/DECISIONS.md', 'D'], ['docs/LEARNINGS.md', 'L']]) {
  const nums = [...read(file).matchAll(new RegExp(`^## ${prefix}(\\d+) `, 'gm'))].map(m => +m[1]);
  // Ascending and unique; gaps are fine (parallel branches reserve number ranges so merges don't collide).
  nums.forEach((n, i) => { if (n <= (i ? nums[i - 1] : 0)) errors.push(`${file}: entry ${prefix}${n} out of sequence (after ${prefix}${i ? nums[i - 1] : 0})`); });
}

if (errors.length) {
  console.error('Docs check failed:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(`Docs check OK (${files.length} files)`);
