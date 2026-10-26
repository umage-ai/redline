// One project's notes as a NoteStore (src/server/store.ts), so notesProtocol can serve it to
// dev servers and the MCP tools can read it. The hub is the store, so it sets what only a
// store may (docs/PROTOCOL.md): resolvedAt when a note is marked done, seen when its author's
// overlay has shown it green, href into the hub's UI. Which notes a dev server is given
// follows D42: open ones, and resolved ones until a little after their author has seen them.

import type { NewNoteRequest, Note } from '../../src/shared/types.ts';
import { STORE_OWNED } from '../../src/shared/types.ts';
import { newId, stamp, validId, type NotePatch, type NoteStore } from '../../src/server/store.ts';
import type { Db, Project } from './db.ts';

/** An error the protocol answers with its own status and words (notesProtocol passes 4xx through). */
export class HubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface Policy {
  /** A resolved note stays listed this long after its author has seen it (ms). Default 5 min. */
  seenFor: number;
  /** ...and at most this long after it was resolved, seen or not (ms). Default 24 h. */
  resolvedFor: number;
}
export const DEFAULT_POLICY: Policy = { seenFor: 5 * 60_000, resolvedFor: 24 * 3_600_000 };

/** The hub's view of a note: the protocol's, plus what only its UI needs. */
export type HubNote = Note & { archived?: boolean; created: number; updated: number };
export type Status = 'open' | 'resolved' | 'archived' | 'all';

interface Row {
  id: string; data: string; body: string; reply: string; done: number; author: string | null;
  resolved: number | null; seen: number | null; archived: number; created: number; updated: number;
}

/** Whether a note may be filed from `url`: any site when the project lists none. `*.` matches subdomains. */
export function siteAllowed(sites: string[], url: string): boolean {
  if (!sites.length) return true;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return sites.some(s => {
    const m = /^(https?:)\/\/\*\.(.+)$/.exec(s);
    return m ? u.protocol === m[1] && u.host.endsWith('.' + m[2]) : u.origin === s;
  });
}

/** Normalise what an admin typed: origins only (scheme://host[:port]), `*.` allowed, duplicates dropped. */
export function cleanSites(input: unknown): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const out = new Set<string>();
  for (const raw of list) {
    const s = String(raw).trim().replace(/\/+$/, '');
    if (!s) continue;
    const wild = /^(https?):\/\/\*\.([a-z0-9.-]+(:\d+)?)$/i.exec(s);
    if (wild) { out.add(`${wild[1].toLowerCase()}://*.${wild[2].toLowerCase()}`); continue; }
    let u: URL;
    try { u = new URL(s); } catch { throw new HubError(400, `"${s}" is not a site; give an origin such as https://staging.example.com`); }
    if (!/^https?:$/.test(u.protocol)) throw new HubError(400, `"${s}": only http and https sites`);
    out.add(u.origin);
  }
  return [...out];
}

export type ProjectStore = ReturnType<typeof projectStore>;

export function projectStore(db: Db, project: Project, o: {
  now: () => number; policy: Policy; href: (id: string) => string; listeners: Set<() => void>;
}) {
  const pid = project.id;
  const changed = () => { db.bump(pid); for (const fn of o.listeners) fn(); };
  const visible = (now: number) => [
    'archived = 0 AND (done = 0 OR (resolved IS NOT NULL AND resolved > ? AND (seen IS NULL OR seen > ?)))',
    [now - o.policy.resolvedFor, now - o.policy.seenFor],
  ] as const;

  const toNote = (r: Row): HubNote => ({
    ...JSON.parse(r.data),
    id: r.id, body: r.body, reply: r.reply, done: !!r.done,
    author: r.author ?? undefined,
    resolvedAt: r.done && r.resolved ? new Date(r.resolved).toISOString() : undefined,
    seen: r.seen ? true : undefined,
    href: o.href(r.id),
    archived: r.archived ? true : undefined,
    created: r.created, updated: r.updated,
  });
  const row = (id: string) => db.q<Row>('SELECT * FROM notes WHERE project = ? AND id = ?').get(pid, id);

  const store = {
    dir: `Redline hub · ${project.name}`,

    // Changes on every write (rev) and when a resolved note ages out of the list (the count).
    async version() {
      const [where, args] = visible(o.now());
      const n = db.q<{ n: number }>(`SELECT count(*) AS n FROM notes WHERE project = ? AND ${where}`).get(pid, ...args)!.n;
      return `${db.rev(pid)}.${n}`;
    },

    async list() {
      const [where, args] = visible(o.now());
      return db.q<Row>(`SELECT * FROM notes WHERE project = ? AND ${where} ORDER BY created, id`).all(pid, ...args).map(toNote);
    },

    async create(req: NewNoteRequest) {
      const n = req.note;
      if (!siteAllowed(project.sites, n.url)) {
        let origin = n.url;
        try { origin = new URL(n.url).origin; } catch { /* keep as sent */ }
        throw new HubError(403, `This project takes notes from ${project.sites.join(', ')} only, not ${origin}. Add the site in the project's settings on the hub.`);
      }
      const id = validId(n.id) && !row(n.id) ? n.id : newId();
      const now = o.now();
      const data: Record<string, unknown> = { ...n, at: stamp(new Date(now)) };
      for (const k of ['id', 'body', 'reply', 'done', 'screenshot', 'sketch', ...STORE_OWNED]) delete data[k];
      const shot = /^data:image\/png;base64,(.+)$/s.exec(req.screenshot ?? '');
      if (shot) {
        db.q('INSERT OR REPLACE INTO assets (project, name, type, data) VALUES (?, ?, ?, ?)').run(pid, `${id}.png`, 'image/png', Buffer.from(shot[1], 'base64'));
        data.screenshot = `${id}.png`;
      }
      if (typeof req.sketch === 'string' && /^\s*<svg[\s>]/.test(req.sketch)) {
        db.q('INSERT OR REPLACE INTO assets (project, name, type, data) VALUES (?, ?, ?, ?)').run(pid, `${id}.svg`, 'image/svg+xml', Buffer.from(req.sketch, 'utf8'));
        data.sketch = `${id}.svg`;
      }
      db.q('INSERT INTO notes (project, id, data, body, reply, done, author, created, updated) VALUES (?, ?, ?, ?, \'\', 0, ?, ?, ?)')
        .run(pid, id, JSON.stringify(data), String(n.body ?? ''), n.author ?? null, now, now);
      changed();
      return toNote(row(id)!);
    },

    /** The protocol's patch, plus `archived` from the hub's UI. Done sets resolvedAt; reopening clears it. */
    async update(id: string, patch: NotePatch & { archived?: boolean }) {
      const r = row(id);
      if (!r) return null;
      const now = o.now();
      const data = JSON.parse(r.data);
      if (typeof patch.to === 'string') data.to = patch.to;
      const done = typeof patch.done === 'boolean' ? patch.done : !!r.done;
      const resolved = done ? (r.done ? r.resolved : now) : null;
      // Seen counts only for a resolved note, once; the author's overlay sends it.
      const seen = !done ? null : patch.seen && !r.seen && !!r.done ? now : r.seen;
      const archived = typeof patch.archived === 'boolean' ? (patch.archived ? 1 : 0) : r.archived;
      db.q('UPDATE notes SET data = ?, body = ?, reply = ?, done = ?, resolved = ?, seen = ?, archived = ?, updated = ? WHERE project = ? AND id = ?')
        .run(JSON.stringify(data), patch.body ?? r.body, patch.reply ?? r.reply, done ? 1 : 0, resolved, seen, archived, now, pid, id);
      changed();
      return toNote(row(id)!);
    },

    async remove(id: string) {
      const gone = db.q('DELETE FROM notes WHERE project = ? AND id = ?').run(pid, id).changes > 0;
      if (gone) {
        db.q('DELETE FROM assets WHERE project = ? AND name IN (?, ?)').run(pid, `${id}.png`, `${id}.svg`);
        changed();
      }
      return gone;
    },

    async asset(name: string) {
      if (!/^[a-z0-9]{4,24}\.(png|svg)$/.test(name)) return null;
      const a = db.q<{ type: string; data: Uint8Array }>('SELECT type, data FROM assets WHERE project = ? AND name = ?').get(pid, name);
      return a ? { type: a.type, data: Buffer.from(a.data) } : null;
    },

    subscribe(onChange: () => void) {
      o.listeners.add(onChange);
      return () => { o.listeners.delete(onChange); };
    },

    /** Every note in a status, newest first: the hub's UI and the agents' tools see past the D42 window. */
    all(status: Status = 'all'): HubNote[] {
      const where = { open: 'archived = 0 AND done = 0', resolved: 'archived = 0 AND done = 1', archived: 'archived = 1', all: '1 = 1' }[status];
      return db.q<Row>(`SELECT * FROM notes WHERE project = ? AND ${where} ORDER BY created DESC, id DESC`).all(pid).map(toNote);
    },
  } satisfies NoteStore & Record<string, unknown>;
  return store;
}
