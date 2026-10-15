import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, GUIDE, initRepo } from '../../src/init.ts';

const skill = '---\nname: redline\n---\n# test skill\n';
const repo = () => fs.mkdtemp(path.join(os.tmpdir(), 'redline-init-'));
const read = (root: string, f: string) => fs.readFile(path.join(root, f), 'utf8');
const has = (root: string, f: string) => existsSync(path.join(root, f));

test('init: a bare repo gets the open standards only (Agent Skills + AGENTS.md)', async () => {
  const root = await repo();
  await initRepo(root, { skill });
  assert.equal(await read(root, GUIDE), skill);
  assert.match(await read(root, 'AGENTS.md'), /## UI feedback \(Redline\)[\s\S]*\.agents\/skills\/redline\/SKILL\.md/);
  assert.match(await read(root, '.gitignore'), /^\.redline\/$/m);
  for (const f of ['.claude', 'CLAUDE.md', 'GEMINI.md', '.gemini', '.github']) assert.equal(has(root, f), false, f);
});

test('init: detects Claude, Gemini and Copilot from their files and only touches what exists', async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# App\n');
  await fs.mkdir(path.join(root, '.gemini'));
  await fs.mkdir(path.join(root, '.github'));
  await fs.writeFile(path.join(root, '.github/copilot-instructions.md'), 'Use pnpm.\n');
  assert.deepEqual(detect(root), ['claude', 'gemini', 'copilot']);
  await initRepo(root, { skill });
  assert.equal(await read(root, '.claude/skills/redline/SKILL.md'), skill);
  assert.match(await read(root, 'CLAUDE.md'), /^# App\n\n## UI feedback \(Redline\)/);
  assert.equal(has(root, 'GEMINI.md'), false);                       // detected via .gemini/, not created
  assert.match(await read(root, '.gemini/commands/redline.toml'), /prompt = """\nWork through[\s\S]*\{\{args\}\}/);
  assert.match(await read(root, '.github/prompts/redline.prompt.md'), /^---\ndescription: .+\n---\n[\s\S]*\(\.\.\/\.\.\/\.agents\/skills\/redline\/SKILL\.md\)/);
});

test('init: asked-for harnesses get CLAUDE.md (importing AGENTS.md) and GEMINI.md created', async () => {
  const root = await repo();
  await initRepo(root, { skill, harnesses: ['claude', 'gemini'], createMissing: true });
  assert.equal(await read(root, 'CLAUDE.md'), '# Project notes\n\n@AGENTS.md\n');   // the section lives in AGENTS.md
  assert.match(await read(root, 'GEMINI.md'), /## UI feedback \(Redline\)/);
  assert.equal(has(root, '.github'), false);
});

test('init: re-running refreshes the skill and adds each section once', async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules');
  await initRepo(root, { skill, harnesses: ['claude'], createMissing: true });
  const log = await initRepo(root, { skill: skill + 'v2\n', harnesses: ['claude'], createMissing: true });
  await fs.appendFile(path.join(root, 'CLAUDE.md'), '\nMore notes.\n');
  await initRepo(root, { skill: skill + 'v2\n', harnesses: ['claude'], createMissing: true });   // an existing CLAUDE.md gets the section, once
  for (const f of ['AGENTS.md', 'CLAUDE.md']) assert.equal((await read(root, f)).split('## UI feedback (Redline)').length, 2, f);
  assert.equal((await read(root, '.gitignore')).match(/\.redline\//g)?.length, 1);
  assert.match(await read(root, '.gitignore'), /^node_modules\n/);
  assert.equal(await read(root, GUIDE), skill + 'v2\n');
  assert.ok(log.some(l => l.includes('AGENTS.md already has the Redline section')));
});
