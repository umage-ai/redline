// Where notes live and which app wrote them. In a monorepo the notes stay in one
// .redline/ at the repo root, and each dev server tags its notes with its folder (D17).

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Nearest folder with .git (a folder, or a file for worktrees/submodules); else `start`. */
export function findRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

export function real(p: string): string {
  try { return realpathSync.native(p); } catch { return p; }
}

/** The dev server's folder relative to the notes root ("apps/web"), or "" when it is the root or outside it. */
export function appOf(root: string, serverRoot: string): string {
  const rel = path.relative(real(root), real(serverRoot)).replace(/\\/g, '/');
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? '' : rel;
}
