// A git worktree per new session (D64): the session runs on its own branch in its own folder, so
// parallel sessions never edit the same files. When it ends, the person decides: keep the branch,
// merge it into the branch it came from (a fast-forward or a clean merge, never forced), or discard
// it (worktree and branch; work not merged is only dropped when they confirm). Nothing is deleted
// silently. The worktree has no node_modules: the agent edits and uses git there; running the app or
// tests in it needs an install (a link to the main node_modules would let an install there rewrite the
// main one, and removing the worktree could follow it).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorktreeInfo } from './types.ts';

/** Runs git; resolves with stdout, rejects with git's own message. */
export function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim().split('\n').pop() || 'git failed'), { code: (err as { code?: unknown }).code }));
      else resolve(String(stdout));
    });
  });
}

/** The repo's top folder for `root`, or why there is none (not a repo, no git). */
export async function gitTop(root: string): Promise<{ top: string } | { why: string }> {
  try { return { top: path.resolve((await git(root, ['rev-parse', '--show-toplevel'])).trim()) }; }
  catch (e) {
    const code = (e as { code?: unknown }).code;
    return { why: code === 'ENOENT' ? 'git is not installed' : 'not a git repository' };
  }
}

/** A branch-name piece from free text: lower case, a–z 0–9 and dashes, at most 40 characters. */
export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

export interface Worktree extends WorktreeInfo {
  /** The folder (absolute). */
  dir: string;
  /** Where the session runs: the same subfolder of the worktree as the project's cwd in the repo. */
  cwd: string;
  /** The repo's main working tree (absolute): where merges happen. */
  top: string;
}

/**
 * A new worktree for a session: branch `<prefix><name>` (a number added when taken) from the current
 * HEAD, in `<dir>/<branch's last part>`. `dir` gets a `.gitignore` of `*`, so the main tree never
 * lists it.
 */
export async function addWorktree(o: { root: string; cwd: string; dir: string; prefix: string; name: string }): Promise<Worktree> {
  const t = await gitTop(o.root);
  if ('why' in t) throw new Error(`no worktree: ${t.why}`);
  const base = (await git(t.top, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (base === 'HEAD') throw new Error('no worktree: the repository is on a detached HEAD (check out a branch first)');
  const taken = new Set((await git(t.top, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').map(s => s.trim()));
  const stem = `${o.prefix}${slug(o.name) || 'session'}`;
  let branch = stem;
  for (let n = 2; taken.has(branch) || existsSync(path.join(o.dir, branch.split('/').pop()!)); n++) branch = `${stem}-${n}`;
  mkdirSync(o.dir, { recursive: true });
  const ignore = path.join(o.dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Agent session worktrees (D64): never part of the main tree.\n*\n');
  const dir = path.join(o.dir, branch.split('/').pop()!);
  await git(t.top, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  const sub = path.relative(t.top, o.cwd);
  const cwd = sub && !sub.startsWith('..') && !path.isAbsolute(sub) ? path.join(dir, sub) : dir;
  return { branch, base, dir, cwd, top: t.top, path: rel(o.root, dir) };
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');

/** Uncommitted changes in the worktree, and commits on its branch that `base` doesn't have. */
export async function status(w: Pick<Worktree, 'dir' | 'top' | 'branch' | 'base'>): Promise<{ dirty: boolean; ahead: number; gone?: boolean }> {
  if (!existsSync(w.dir)) return { dirty: false, ahead: await ahead(w).catch(() => 0), gone: true };
  const [porcelain, n] = await Promise.all([git(w.dir, ['status', '--porcelain']).catch(() => ''), ahead(w).catch(() => 0)]);
  return { dirty: porcelain.trim() !== '', ahead: n };
}
const ahead = async (w: Pick<Worktree, 'top' | 'branch' | 'base'>) => Number((await git(w.top, ['rev-list', '--count', `${w.base}..${w.branch}`])).trim()) || 0;

export type WorktreeAction = 'keep' | 'merge' | 'discard';
export interface ActionResult { ok: boolean; message: string; /** Still on disk or as a branch: keep it listed. */ kept: boolean; /** Confirmation needed (discard with work on it). */ confirm?: boolean }

/**
 * What the person picked for an ended session's worktree.
 * - keep: the branch stays; the folder is removed when it has no uncommitted changes (else it stays too).
 * - merge: into `base`, only when the main tree is on `base`, the worktree is committed, and the merge
 *   fast-forwards or is clean (`git merge-tree`); then the worktree and the (merged) branch go.
 * - discard: worktree and branch go; with uncommitted changes or unmerged commits only when `confirm`.
 */
export async function act(w: Worktree, action: WorktreeAction, confirm = false): Promise<ActionResult> {
  const s = await status(w);
  if (action === 'keep') {
    if (s.dirty) return { ok: true, kept: true, message: `Kept ${w.branch} and its folder ${w.path} (it has uncommitted changes)` };
    if (!s.gone) await git(w.top, ['worktree', 'remove', w.dir]);
    return { ok: true, kept: false, message: `Kept the branch ${w.branch}` };
  }
  if (action === 'discard') {
    if ((s.dirty || s.ahead) && !confirm) {
      const what = [s.dirty && 'uncommitted changes', s.ahead && `${s.ahead} commit${s.ahead === 1 ? '' : 's'} not on ${w.base}`].filter(Boolean).join(' and ');
      return { ok: false, kept: true, confirm: true, message: `${w.branch} has ${what}: discarding deletes them` };
    }
    if (!s.gone) await git(w.top, ['worktree', 'remove', '--force', w.dir]);
    await git(w.top, ['worktree', 'prune']).catch(() => '');
    await git(w.top, ['branch', '-D', w.branch]).catch(() => '');
    return { ok: true, kept: false, message: `Discarded ${w.branch}` };
  }
  // merge
  if (s.dirty) return { ok: false, kept: true, message: `${w.branch} has uncommitted changes: commit them in ${w.path} (or ask the agent to), then merge` };
  if (!s.ahead) {
    if (!s.gone) await git(w.top, ['worktree', 'remove', w.dir]);
    await git(w.top, ['branch', '-d', w.branch]).catch(() => '');
    return { ok: true, kept: false, message: `${w.branch} had nothing to merge: removed` };
  }
  const head = (await git(w.top, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (head !== w.base) return { ok: false, kept: true, message: `The project is on ${head}, not ${w.base}: check out ${w.base} to merge ${w.branch}` };
  const ff = await git(w.top, ['merge-base', '--is-ancestor', w.base, w.branch]).then(() => true, () => false);
  if (!ff) {
    // A clean merge or none: merge-tree computes it without touching any working tree (git 2.38+).
    const clean = await git(w.top, ['merge-tree', '--write-tree', w.base, w.branch]).then(() => true, () => false);
    if (!clean) return { ok: false, kept: true, message: `${w.branch} doesn't merge cleanly into ${w.base}: merge it by hand` };
  }
  try { await git(w.top, ['merge', ff ? '--ff-only' : '--no-edit', w.branch]); }
  catch (e) {
    await git(w.top, ['merge', '--abort']).catch(() => '');
    return { ok: false, kept: true, message: `Merging ${w.branch} failed: ${(e as Error).message}` };
  }
  if (!s.gone) await git(w.top, ['worktree', 'remove', w.dir]).catch(() => '');
  await git(w.top, ['branch', '-d', w.branch]).catch(() => '');
  return { ok: true, kept: false, message: `Merged ${w.branch} into ${w.base}${ff ? ' (fast-forward)' : ''}` };
}

/** Worktrees left in `dir` by an earlier run (the process ended before anyone decided): listed again. */
export async function leftover(o: { root: string; dir: string; prefix: string }): Promise<Worktree[]> {
  const t = await gitTop(o.root);
  if ('why' in t || !existsSync(o.dir)) return [];
  const out: Worktree[] = [];
  const list = await git(t.top, ['worktree', 'list', '--porcelain']).catch(() => '');
  const base = (await git(t.top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim();
  for (const block of list.split(/\n\n+/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!dir || !branch || !branch.startsWith(o.prefix)) continue;
    const abs = path.resolve(dir);
    if (path.relative(path.resolve(o.dir), abs).startsWith('..')) continue;
    out.push({ branch, base, dir: abs, cwd: abs, top: t.top, path: rel(o.root, abs) });
  }
  return out;
}
