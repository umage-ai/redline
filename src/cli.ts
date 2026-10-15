#!/usr/bin/env node
// redline init [dir] [--agents=claude,gemini,copilot|all|none] [--claude-md]
// Sets a repo up for Redline with any coding agent; see src/init.ts for what is written.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_AGENTS, detect, GUIDE, HARNESSES, initRepo, type Harness } from './init.ts';
import { findRoot } from './server/root.ts';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const args = rest.flatMap(a => (a.startsWith('--') && a.includes('=') ? a.split('=') : [a]));
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : ''; };
const given = path.resolve(args.find((a, i) => !a.startsWith('--') && !(args[i - 1] === '--agents')) ?? '.');

// Notes live at the repo root (nearest .git), so the guide goes there too, even when run inside apps/web.
const target = flag('--here') !== undefined ? given : findRoot(given);

const USAGE = `Usage: redline init [dir] [--agents=<list>] [--here] [--claude-md]

Always writes ${GUIDE} and an AGENTS.md section (Codex, Cursor, Copilot,
Windsurf, Zed, Amp, Jules, OpenCode, …) and gitignores .redline/.

  --agents=<list>  extras: ${HARNESSES.join(', ')}, "all" or "none" (${BASELINE_AGENTS.slice(1).join(', ')}
                   need nothing extra and are accepted too). Default: the ones found in the repo
                   (CLAUDE.md or .claude/, GEMINI.md or .gemini/, .github/copilot-instructions.md …).
                   Listed harnesses also get a CLAUDE.md / GEMINI.md if the repo has none.
  --here           install in [dir] itself, not at its repo root (only when the plugin's \`root\` option
                   points there too).
  --claude-md      same as --agents=claude (kept for older setups).

In a monorepo, run it anywhere: it installs at the repo root (nearest .git), where every app's notes go.`;

async function init() {
  const list = flag('--agents');
  let harnesses: Harness[] | undefined;
  if (list !== undefined) {
    const names = list.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const bad = names.filter(n => n !== 'all' && n !== 'none' && !HARNESSES.includes(n as Harness) && !BASELINE_AGENTS.includes(n));
    if (bad.length) { console.error(`Unknown agent(s): ${bad.join(', ')}\n\n${USAGE}`); process.exit(1); }
    harnesses = names.includes('all') ? [...HARNESSES] : names.filter((n): n is Harness => HARNESSES.includes(n as Harness));
  }
  if (flag('--claude-md') !== undefined) harnesses = [...new Set([...(harnesses ?? detect(target)), 'claude' as const])];

  if (target !== given) console.log(`Monorepo: setting up the repo root ${target} (notes from every app go to its .redline/).
`);
  const skill = await fs.readFile(fileURLToPath(new URL('../skill/SKILL.md', import.meta.url)), 'utf8');
  const log = await initRepo(target, { skill, harnesses, createMissing: harnesses !== undefined });
  for (const l of log) console.log(l);
  const used = harnesses ?? detect(target);
  console.log(`\nAgents: AGENTS.md + Agent Skills${used.length ? ', ' + used.join(', ') : ''}.`);
  console.log('Next: add the plugin to your dev server (see README), run dev, press Alt+Shift+R.');
}

if (cmd === 'init') await init();
else console.log(USAGE);
