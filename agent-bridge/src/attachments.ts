// Attachments (D56): what a session pointed at in a round (one prompt and its turn), most reliable first:
//   explicit  the agent said so: an MCP `attach` call (the host's tool), ACP content (resource links,
//             images, diffs, a tool call's file locations)
//   changed   files that changed in the round: a git snapshot of the working tree when the prompt went
//             in, compared when the turn is done (in the session's worktree, D64, when it has one)
//   link      OSC 8 hyperlinks in the CLI's output (exact: the CLI marked them)
//   mentioned URLs and file paths in the output text; a path counts only when the file exists inside
//             the session's folder (lowest prominence)
// They are references: dropped with the session (changed files stay in git anyway). URLs are never
// fetched by the server; files are served only from inside the session's folder (realpath, no symlink
// escape), images and text only, size-capped.

import { execFile } from 'node:child_process';
import { promises as fs, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './worktrees.ts';
import type { Attachment } from './types.ts';

export const MAX_FILE = 5 * 1024 * 1024;
const MAX_PER_ROUND = 200;
const MAX_ROUNDS = 50;

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };
const TEXT = new Set(['.txt', '.md', '.markdown', '.json', '.jsonc', '.csv', '.log', '.yml', '.yaml', '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.astro', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.cshtml', '.razor', '.php', '.sh', '.ps1', '.sql', '.diff', '.patch']);

/** How a file may be served: an image or text type, or null (not served). */
export function fileType(p: string): { type: string; image: boolean } | null {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE[ext]) return { type: IMAGE[ext], image: true };
  if (TEXT.has(ext) || /(^|[\\/])(readme|license|changelog|dockerfile|makefile)$/i.test(p)) return { type: 'text/plain; charset=utf-8', image: false };
  return null;
}

/**
 * `p` (relative to `base`, or absolute) as a path inside `base`, symlinks resolved; null when it
 * escapes (`..`, an absolute path elsewhere, a symlink pointing out) or doesn't exist.
 */
export function inside(base: string, p: string): { abs: string; rel: string } | null {
  if (!p || p.includes('\0')) return null;
  let realBase: string, real: string;
  try { realBase = realpathSync.native(base); real = realpathSync.native(path.resolve(base, p)); } catch { return null; }
  const rel = path.relative(realBase, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { abs: real, rel: rel.split(path.sep).join('/') };
}

// OSC 8: ESC ] 8 ; params ; URI (ST | BEL) text ESC ] 8 ; ; (ST | BEL)
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;[^;\x07\x1b]*;(?:\x07|\x1b\\)/g;
/** The hyperlinks a CLI marked with OSC 8, in order, each once: the URI and the text it was shown as. */
export function osc8Links(output: string): { uri: string; text: string }[] {
  const out: { uri: string; text: string }[] = [], seen = new Set<string>();
  for (const m of output.matchAll(OSC8)) {
    const uri = m[1].trim();
    if (!uri || seen.has(uri) || uri.length > 2048) continue;
    seen.add(uri);
    out.push({ uri, text: stripAnsi(m[2]).trim().slice(0, 200) });
  }
  return out;
}

/** Terminal output as plain text: escape sequences (CSI, OSC, others) and control characters removed. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ').replace(/\x1b[@-Z\\-_]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}|]+/g;
// A path: an optional ./ or ../ or drive, segments with a slash between, ending in a name with an extension;
// or a bare name with an extension (README.md). Trailing punctuation and a :line(:col) are dropped.
const PATH_RE = /(?:^|[\s"'`(\[{<])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?(?=$|[\s"'`)\]}>,;:!?]|\.(?:\s|$))/gm;

/**
 * URLs and paths of existing files in plain text (D56 "mentioned"). A path is kept only when the file
 * exists inside `base` (resolved from `cwd`, then `base`); returned relative to `base`. At most `max` of each.
 */
export function mentions(text: string, base: string, cwd = base, max = 50): { urls: string[]; paths: string[] } {
  const urls: string[] = [], paths: string[] = [], seenU = new Set<string>(), seenP = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (!seenU.has(u) && urls.length < max) { seenU.add(u); urls.push(u); }
  }
  const noUrls = text.replace(URL_RE, ' ');
  for (const m of noUrls.matchAll(PATH_RE)) {
    if (paths.length >= max) break;
    const raw = m[1];
    if (seenP.has(raw)) continue;
    seenP.add(raw);
    const hit = [cwd, base].map(b => inside(base, path.resolve(b, raw))).find(Boolean);
    if (!hit || seenP.has('@' + hit.rel)) continue;
    try { if (!statSync(hit.abs).isFile()) continue; } catch { continue; }
    seenP.add('@' + hit.rel);
    paths.push(hit.rel);
  }
  return { urls, paths };
}

/** A URL for this machine (localhost, 127.x, ::1, *.localhost): a viewer may open it in a new tab. */
export function localUrl(u: string): boolean {
  try {
    const { hostname, protocol } = new URL(u);
    return /^https?:$/.test(protocol) && /^(localhost|127(\.\d+){3}|\[::1\]|[^.]+\.localhost)$/i.test(hostname);
  } catch { return false; }
}

/**
 * The working tree as a git tree id, untracked files included (ignored ones not), without touching
 * the real index or anything checked out: `git add -A` into a copy of the index, then `write-tree`.
 * Null when `cwd` isn't in a git repo.
 */
export async function snapshot(cwd: string): Promise<string | null> {
  let index: string;
  try { index = path.resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'index'])).trim()); } catch { return null; }
  const tmp = path.join(os.tmpdir(), `agent-bridge-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.copyFile(index, tmp).catch(() => { /* a fresh repo has no index yet: start empty */ });
    const env = { ...process.env, GIT_INDEX_FILE: tmp, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (e, out, err) => e ? reject(new Error(String(err || e.message))) : resolve(String(out))));
    await run(['add', '-A', '--', ':/']);
    return (await run(['write-tree'])).trim() || null;
  } catch { return null; }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

/** The files that differ between two snapshots, with lines added and removed (binary: 0/0) and git's status letter. */
export async function changedFiles(cwd: string, before: string, after: string): Promise<{ path: string; added: number; removed: number; status: string }[]> {
  if (before === after) return [];
  const [numstat, names] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '--no-renames', before, after]),
    git(cwd, ['diff', '--name-status', '-z', '--no-renames', before, after]),
  ]);
  const status = new Map<string, string>();
  const ns = names.split('\0');
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i][0]);
  const out: { path: string; added: number; removed: number; status: string }[] = [];
  for (const rec of numstat.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) continue;
    out.push({ path: m[3], added: m[1] === '-' ? 0 : +m[1], removed: m[2] === '-' ? 0 : +m[2], status: status.get(m[3]) ?? 'M' });
  }
  return out.slice(0, MAX_PER_ROUND);
}

/** One file's unified diff between two snapshots, capped. */
export async function fileDiff(cwd: string, before: string, after: string, file: string, max = 200_000): Promise<string> {
  const d = await git(cwd, ['diff', '--no-color', '--no-renames', before, after, '--', file]);
  return d.length > max ? d.slice(0, max) + '\n… (cut)\n' : d;
}

/** One round's attachments and the snapshots its changed files are diffed between. */
export interface Round { n: number; task?: string; at: number; done: boolean; finishing?: boolean; before?: string | null; after?: string | null; items: Attachment[] }

/**
 * A session's rounds (D56). `begin` at each prompt (a snapshot first), `add` as things come in,
 * `finish` when the turn is done (changed files, then links and mentions from the round's output).
 */
export class Rounds {
  readonly list: Round[] = [];
  private output = '';
  /** The session's folder (its worktree, or the project root): paths are relative to it. */
  base: string;
  cwd: string;
  private onChange: () => void;
  constructor(base: string, cwd: string, onChange: () => void) { this.base = base; this.cwd = cwd; this.onChange = onChange; }

  get current(): Round | undefined { return this.list[this.list.length - 1]; }
  /** Attachments worth a count on the tab: everything but mere mentions. */
  get count() { return this.list.reduce((n, r) => n + r.items.filter(i => i.source !== 'mentioned').length, 0); }

  async begin(task?: string) {
    if (this.current && !this.current.done && !this.current.finishing) await this.finish();   // a prompt queued mid-turn: the old round closes
    const r: Round = { n: (this.current?.n ?? 0) + 1, task, at: Date.now(), done: false, items: [] };
    this.list.push(r);
    if (this.list.length > MAX_ROUNDS) this.list.shift();
    this.output = '';
    r.before = await snapshot(this.cwd);
    this.onChange();
  }

  /** CLI output during the round (PTY data, ACP text): scanned for links and mentions when it finishes. */
  feed(text: string) {
    if (!this.current || this.current.done || this.current.finishing) return;
    this.output += text;
    if (this.output.length > 512 * 1024) this.output = this.output.slice(-512 * 1024);
  }

  /** An attachment for the current round (a new one is started when there is none); repeats are dropped. */
  add(a: Omit<Attachment, 'id' | 'round'>): Attachment | null {
    if (!this.current) { const r: Round = { n: 1, at: Date.now(), done: false, items: [] }; this.list.push(r); }
    const r = this.current!;
    const key = (x: Pick<Attachment, 'path' | 'url' | 'kind'>) => `${x.kind === 'image' ? 'file' : x.kind}:${x.path ?? x.url}`;
    const dupe = r.items.find(x => key(x) === key(a));
    if (dupe) {
      // A stronger source wins (explicit over link over mentioned); a title fills in.
      const rank = { explicit: 3, changed: 2, link: 1, mentioned: 0 } as const;
      if (rank[a.source] > rank[dupe.source]) dupe.source = a.source;
      if (a.title && !dupe.title) dupe.title = a.title;
      this.onChange();
      return dupe;
    }
    if (r.items.length >= MAX_PER_ROUND) return null;
    const item: Attachment = { ...a, id: `${r.n}-${r.items.length + 1}`, round: r.n };
    r.items.push(item);
    this.onChange();
    return item;
  }

  /** A file the agent named (MCP `attach`, ACP): kept only inside the session's folder. */
  addFile(p: string, source: Attachment['source'], title?: string): Attachment | null {
    const hit = inside(this.base, path.resolve(this.cwd, p)) ?? inside(this.base, p);
    if (!hit) return null;
    return this.add({ source, kind: fileType(hit.rel)?.image ? 'image' : 'file', path: hit.rel, ...(title ? { title } : {}) });
  }

  /** A URL the agent named; only http(s). */
  addUrl(u: string, source: Attachment['source'], title?: string): Attachment | null {
    try { if (!/^https?:$/.test(new URL(u).protocol)) return null; } catch { return null; }
    return this.add({ source, kind: 'url', url: u, ...(title ? { title } : {}) });
  }

  /** The turn is done: changed files from git, then OSC 8 links and mentions from its output. */
  async finish() {
    const r = this.current;
    if (!r || r.done || r.finishing) return;
    r.finishing = true;   // done once everything is in: a viewer seeing done sees the whole round
    const text = this.output;
    this.output = '';
    if (r.before) {
      r.after = await snapshot(this.cwd);
      if (r.after) {
        const top = await this.top();
        for (const f of await changedFiles(this.cwd, r.before, r.after).catch(() => [])) {
          // git names files from the repo's top; shown relative to the session's folder (outside it: left out).
          const rel = path.relative(this.base, path.join(top, f.path));
          if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
          this.add({ source: 'changed', kind: 'diff', path: rel.split(path.sep).join('/'), added: f.added, removed: f.removed, status: f.status });
        }
      }
    }
    for (const l of osc8Links(text)) {
      if (l.uri.startsWith('file://')) {
        try { this.addFile(decodeURIComponent(new URL(l.uri).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'link', l.text || undefined); } catch { /* bad URI */ }
      } else this.addUrl(l.uri, 'link', l.text && l.text !== l.uri ? l.text : undefined);
    }
    const m = mentions(stripAnsi(text), this.base, this.cwd);
    for (const u of m.urls) this.addUrl(u, 'mentioned');
    for (const p of m.paths) this.addFile(p, 'mentioned');
    r.done = true;
    this.onChange();
  }

  private gitTop?: string;
  /** The repo's top folder (git names files from there). */
  async top(): Promise<string> {
    return this.gitTop ??= path.resolve((await git(this.cwd, ['rev-parse', '--show-toplevel']).catch(() => this.cwd)).trim());
  }

  /** A changed file's diff in round `n` (its path as listed: relative to the session's folder). */
  async diff(n: number, rel: string): Promise<string | null> {
    const r = this.list.find(x => x.n === n);
    const item = r?.items.find(i => i.kind === 'diff' && i.path === rel);
    if (!r?.before || !r.after || !item) return null;
    const top = await this.top();
    return fileDiff(this.cwd, r.before, r.after, ':(top)' + path.relative(top, path.join(this.base, rel)).split(path.sep).join('/'));
  }

  /** For /attachments: newest round first. */
  view() { return [...this.list].reverse().map(r => ({ n: r.n, task: r.task, at: r.at, done: r.done, items: r.items })); }
}
