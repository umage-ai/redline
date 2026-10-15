// `redline init`: set a repo up so any coding agent can work through .redline/ notes (D16).
//
// Always (open standards, read by most agents):
//   .agents/skills/redline/SKILL.md   Agent Skills folder: Codex, Cursor, Copilot/VS Code, OpenCode, …
//   AGENTS.md                         a short Redline section: Codex, Cursor, Copilot, Windsurf, Zed, Amp, Jules, …
//   .gitignore                        .redline/
// Per harness, when detected or asked for with --agents:
//   claude   .claude/skills/redline/SKILL.md, a CLAUDE.md section
//   gemini   a GEMINI.md section, .gemini/commands/redline.toml (/redline)
//   copilot  .github/prompts/redline.prompt.md (/redline in VS Code chat)

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';

export const HARNESSES = ['claude', 'gemini', 'copilot'] as const;
export type Harness = typeof HARNESSES[number];
/** Agents fully served by the AGENTS.md + Agent Skills baseline; accepted by --agents, nothing extra to write. */
export const BASELINE_AGENTS = ['agents', 'codex', 'cursor', 'windsurf', 'zed', 'amp', 'jules', 'opencode', 'devin', 'factory'];

/** Where agents find the guide; also what the overlay's prompt points at. */
export const GUIDE = '.agents/skills/redline/SKILL.md';
export const GUIDE_PATHS = [GUIDE, '.claude/skills/redline/SKILL.md', '.github/skills/redline/SKILL.md'];

const HEADING = '## UI feedback (Redline)';
export const SECTION = `
${HEADING}

In dev, a reviewer pins comments, sketches and text changes on the running UI (Alt+Shift+R in the browser).
They are saved under \`.redline/\` (gitignored): start at \`.redline/INDEX.md\`, then \`.redline/pages/*.md\`.
To apply them, follow \`${GUIDE}\` (the \`redline\` skill).
`;

const TASK = `Work through the open Redline UI feedback in .redline/INDEX.md. Follow ${GUIDE}.`;

const MARKERS: Record<Harness, string[]> = {
  claude: ['CLAUDE.md', '.claude'],
  gemini: ['GEMINI.md', '.gemini'],
  copilot: ['.github/copilot-instructions.md', '.github/instructions', '.github/prompts'],
};

export function detect(root: string): Harness[] {
  return HARNESSES.filter(h => MARKERS[h].some(m => existsSync(path.join(root, m))));
}

export interface InitOptions {
  /** Harnesses to set up on top of the AGENTS.md baseline. Default: the ones detected in the repo. */
  harnesses?: Harness[];
  /** Create CLAUDE.md / GEMINI.md when missing for harnesses that were asked for (not just detected). */
  createMissing?: boolean;
  /** The skill text (skill/SKILL.md in the package). */
  skill: string;
}

/** Sets the repo up and returns one log line per step. Safe to re-run: files are refreshed, sections added once. */
export async function initRepo(root: string, opts: InitOptions): Promise<string[]> {
  const log: string[] = [];
  const harnesses = opts.harnesses ?? detect(root);
  const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');

  const write = async (file: string, text: string) => {
    const abs = path.join(root, file);
    const had = existsSync(abs) && (await fs.readFile(abs, 'utf8')) === text;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
    log.push(`${had ? '·' : '✓'} ${rel(abs)}${had ? ' (up to date)' : ''}`);
  };
  /** Append the Redline section; create the file (with `fresh` as its start) only when asked to. */
  const section = async (file: string, fresh: string | null) => {
    const abs = path.join(root, file);
    if (existsSync(abs)) {
      const text = await fs.readFile(abs, 'utf8');
      if (text.includes(HEADING)) { log.push(`· ${file} already has the Redline section`); return; }
      await fs.writeFile(abs, text + (text.endsWith('\n') ? '' : '\n') + SECTION);
      log.push(`✓ ${file}: added the Redline section`);
    } else if (fresh !== null) {
      await fs.writeFile(abs, fresh + SECTION);
      log.push(`✓ ${file} created`);
    }
  };

  await write(GUIDE, opts.skill);
  await section('AGENTS.md', '# AGENTS.md\n');

  const gi = path.join(root, '.gitignore');
  const cur = existsSync(gi) ? await fs.readFile(gi, 'utf8') : '';
  if (!/^\/?\.redline\/?$/m.test(cur)) {
    await fs.writeFile(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '\n# Redline UI feedback notes (dev only)\n.redline/\n');
    log.push('✓ .gitignore: added .redline/');
  } else log.push('· .gitignore already ignores .redline/');

  const create = opts.createMissing ?? false;
  if (harnesses.includes('claude')) {
    await write('.claude/skills/redline/SKILL.md', opts.skill);
    // A new CLAUDE.md just imports AGENTS.md (which has the section), so there's one place to edit.
    if (!existsSync(path.join(root, 'CLAUDE.md')) && create) await write('CLAUDE.md', '# Project notes\n\n@AGENTS.md\n');
    else await section('CLAUDE.md', null);
  }
  if (harnesses.includes('gemini')) {
    await section('GEMINI.md', create ? '# Project notes\n' : null);
    await write('.gemini/commands/redline.toml',
      `description = "Apply the open Redline UI feedback notes in .redline/"\nprompt = """\n${TASK}\n{{args}}\n"""\n`);
  }
  if (harnesses.includes('copilot')) {
    await write('.github/prompts/redline.prompt.md',
      `---\ndescription: Apply the open Redline UI feedback notes in .redline/\n---\n\n${TASK.replace(GUIDE, `[the redline skill](../../${GUIDE})`)}\n`);
  }
  return log;
}
