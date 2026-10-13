#!/usr/bin/env node
// redline init [dir]  — set a repo up for Redline:
//   • copies the redline skill into .claude/skills/redline/
//   • adds .redline/ to .gitignore
//   • appends a short pointer to CLAUDE.md (if one exists, or creates it with --claude-md)

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith('--')));
const target = path.resolve(rest.find(a => !a.startsWith('--')) ?? '.');
const skillSrc = fileURLToPath(new URL('../skill/SKILL.md', import.meta.url));

const CLAUDE_BLOCK = `
## UI feedback (Redline)

In dev, press **Alt+Shift+R** in the browser to pin comments, sketches and text changes on the UI.
They are saved under \`.redline/\` (gitignored): start at \`.redline/INDEX.md\`, then \`.redline/pages/*.md\`.
Use the \`redline\` skill to work through open notes.
`;

async function init() {
  const skillDir = path.join(target, '.claude', 'skills', 'redline');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.copyFile(skillSrc, path.join(skillDir, 'SKILL.md'));
  console.log(`✓ skill  → ${path.relative(process.cwd(), path.join(skillDir, 'SKILL.md')) || 'SKILL.md'}`);

  const gi = path.join(target, '.gitignore');
  const cur = existsSync(gi) ? await fs.readFile(gi, 'utf8') : '';
  if (!/^\/?\.redline\/?$/m.test(cur)) {
    await fs.writeFile(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '\n# Redline UI feedback notes (dev only)\n.redline/\n');
    console.log('✓ .gitignore: added .redline/');
  } else console.log('· .gitignore already ignores .redline/');

  const cm = path.join(target, 'CLAUDE.md');
  if (existsSync(cm)) {
    const text = await fs.readFile(cm, 'utf8');
    if (!text.includes('Redline')) { await fs.appendFile(cm, CLAUDE_BLOCK); console.log('✓ CLAUDE.md: added a Redline section'); }
    else console.log('· CLAUDE.md already mentions Redline');
  } else if (flags.has('--claude-md')) {
    await fs.writeFile(cm, '# Project notes\n' + CLAUDE_BLOCK);
    console.log('✓ CLAUDE.md created');
  }
  console.log('\nNext: add the plugin to your dev server (see README), run dev, press Alt+Shift+R.');
}

if (cmd === 'init') await init();
else console.log('Usage: redline init [repo-dir] [--claude-md]');
