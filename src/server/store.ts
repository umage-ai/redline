// File store for notes: <root>/<dir>/pages/<slug>.md, <dir>/assets/<id>.{png,svg},
// <dir>/INDEX.md. Every mutation re-reads the page file, applies the change and
// writes it back, so edits an agent made in between are kept. Mutations are
// queued so two quick saves from the overlay can't interleave.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Note, NewNoteRequest } from '../shared/types.ts';
import { pageFile, parsePage, serializeIndex, serializePage } from './format.ts';

export interface StoreOptions {
  root: string;     // project root
  dir?: string;     // folder for notes, relative to root (default .redline)
}

/** `seen`: the author has seen the note resolved (remote stores, D42); the markdown store ignores it. */
export type NotePatch = Partial<Pick<Note, 'body' | 'reply' | 'done' | 'to' | 'seen'>>;

/** Keep only the fields a patch may carry, with the right types (the API takes them from the page). */
export function cleanPatch(p: unknown): NotePatch {
  const src = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const out: NotePatch = {};
  for (const k of ['body', 'reply', 'to'] as const) if (typeof src[k] === 'string') out[k] = src[k] as string;
  for (const k of ['done', 'seen'] as const) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  return out;
}

/**
 * Where notes are kept. The markdown store below is the default; pass your own as the
 * `store` option to keep notes elsewhere (D19). `file` on a note is optional: it is only
 * shown to the reviewer and named in the copied agent prompt.
 */
export interface NoteStore {
  /** Shown to the reviewer as where notes go (".redline", a URL, a CMS name). */
  dir: string;
  /** Changes whenever any note changes; the overlay polls with it as an ETag, so keep it cheap. */
  version(): Promise<string>;
  list(): Promise<(Note & { file?: string })[]>;
  /** Assign `id` (keep a valid `req.note.id`) and `at`, keep the screenshot/sketch, return the note. */
  create(req: NewNoteRequest): Promise<Note & { file?: string }>;
  update(id: string, patch: NotePatch): Promise<Note | null>;
  remove(id: string): Promise<boolean>;
  /** A note's screenshot (`<id>.png`) or sketch (`<id>.svg`) by file name, or null. */
  asset(name: string): Promise<{ type: string; data: Buffer | string } | null>;
  /**
   * Optional (D41): call `onChange` whenever a note changes, for as long as the subscription
   * lasts; return the unsubscribe. With it the overlay hears about changes at once instead of
   * on its next poll. Without it nothing changes: the overlay polls.
   */
  subscribe?(onChange: () => void): () => void;
}

/** Note ids are lowercase base36, 4–24 chars; custom stores should keep to it (the API routes on it). */
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9]{4,24}$/.test(id);

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const newId = () => Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
export { stamp };

/** The default store: markdown under <root>/.redline/ (D2). */
export function createStore(opts: StoreOptions) {
  const dirRel = opts.dir ?? '.redline';
  const base = path.resolve(opts.root, dirRel);
  const pagesDir = path.join(base, 'pages');
  const assetsDir = path.join(base, 'assets');
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function pageFiles(): Promise<string[]> {
    try {
      return (await fs.readdir(pagesDir)).filter(f => f.endsWith('.md')).sort();
    } catch { return []; }
  }

  async function readFile(file: string): Promise<Note[]> {
    try { return parsePage(await fs.readFile(path.join(pagesDir, file), 'utf8')); }
    catch { return []; }
  }

  async function writeFile(file: string, notes: Note[]) {
    const full = path.join(pagesDir, file);
    if (!notes.length) { await fs.rm(full, { force: true }); return; }
    const first = notes[0];
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.writeFile(full, serializePage(first.page, first.url, notes));
  }

  async function writeIndex() {
    const rows = [];
    for (const file of await pageFiles()) {
      const notes = await readFile(file);
      if (!notes.length) continue;
      rows.push({ page: notes[0].page, app: notes[0].app, file: `pages/${file}`, open: notes.filter(n => !n.done).length, done: notes.filter(n => n.done).length });
    }
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, 'INDEX.md'), serializeIndex(rows));
  }

  async function findNote(id: string): Promise<{ file: string; notes: Note[]; i: number } | null> {
    for (const file of await pageFiles()) {
      const notes = await readFile(file);
      const i = notes.findIndex(n => n.id === id);
      if (i >= 0) return { file, notes, i };
    }
    return null;
  }

  /** Resolve a request path under assets/ to a file, or null. */
  function assetPath(name: string): string | null {
    if (!/^[a-z0-9]+\.(png|svg)$/.test(name)) return null;
    return path.join(assetsDir, name);
  }

  async function removeAssets(n: Note) {
    for (const rel of [n.screenshot, n.sketch]) {
      if (!rel) continue;
      const full = path.resolve(pagesDir, rel);
      if (full.startsWith(assetsDir + path.sep)) await fs.rm(full, { force: true });
    }
  }

  return {
    dir: dirRel,
    base,

    async version(): Promise<string> {
      const h = crypto.createHash('sha1');
      for (const f of await pageFiles()) {
        try { const s = await fs.stat(path.join(pagesDir, f)); h.update(`${f}:${s.mtimeMs}:${s.size};`); } catch { /* raced a delete */ }
      }
      return h.digest('hex').slice(0, 12);
    },

    async list(): Promise<(Note & { file: string })[]> {
      const out: (Note & { file: string })[] = [];
      for (const file of await pageFiles())
        for (const n of await readFile(file)) out.push({ ...n, file: `${dirRel}/pages/${file}` });
      return out;
    },

    create(req: NewNoteRequest): Promise<Note & { file: string }> {
      return serial(async () => {
        const id = validId(req.note.id) ? req.note.id : newId();
        const note: Note = { ...req.note, id, at: stamp(), body: req.note.body ?? '', reply: '', done: false };
        if (req.screenshot?.startsWith('data:image/png;base64,')) {
          await fs.mkdir(assetsDir, { recursive: true });
          await fs.writeFile(path.join(assetsDir, `${id}.png`), Buffer.from(req.screenshot.slice(22), 'base64'));
          note.screenshot = `../assets/${id}.png`;
        }
        if (req.sketch?.trimStart().startsWith('<svg')) {
          await fs.mkdir(assetsDir, { recursive: true });
          await fs.writeFile(path.join(assetsDir, `${id}.svg`), req.sketch);
          note.sketch = `../assets/${id}.svg`;
        }
        const file = pageFile(note.page, note.app);
        const notes = await readFile(file);
        notes.push(note);
        await writeFile(file, notes);
        await writeIndex();
        return { ...note, file: `${dirRel}/pages/${file}` };
      });
    },

    update(id: string, patch: NotePatch): Promise<Note | null> {
      return serial(async () => {
        const hit = await findNote(id);
        if (!hit) return null;
        const n = hit.notes[hit.i];
        if (typeof patch.body === 'string') n.body = patch.body;
        if (typeof patch.reply === 'string') n.reply = patch.reply;
        if (typeof patch.to === 'string' && n.type === 'text') n.to = patch.to;
        if (typeof patch.done === 'boolean') n.done = patch.done;
        await writeFile(hit.file, hit.notes);
        await writeIndex();
        return n;
      });
    },

    remove(id: string): Promise<boolean> {
      return serial(async () => {
        const hit = await findNote(id);
        if (!hit) return false;
        const [n] = hit.notes.splice(hit.i, 1);
        await removeAssets(n);
        await writeFile(hit.file, hit.notes);
        await writeIndex();
        return true;
      });
    },

    assetPath,

    async asset(name: string) {
      const file = assetPath(name);
      if (!file) return null;
      try { return { type: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png', data: await fs.readFile(file) }; }
      catch { return null; }
    },
  } satisfies NoteStore & Record<string, unknown>;
}

export type Store = ReturnType<typeof createStore>;
