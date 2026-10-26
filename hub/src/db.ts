// The hub's SQLite database (node:sqlite, built into Node 22.13+): projects, the people and
// agents with a token for one, notes with their screenshots, and UI sessions. Tokens, the
// admin key and sessions are stored as SHA-256 hashes only.

import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

/** node:sqlite through getBuiltinModule, so the CLI can silence its experimental warning first. */
function sqlite(): typeof import('node:sqlite') {
  return process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
export const secret = (prefix: string) => prefix + crypto.randomBytes(24).toString('base64url');

export interface Project { id: number; slug: string; name: string; sites: string[]; created: number }
export interface Token { id: number; project: number; person: string; kind: 'member' | 'agent'; created: number; used: number | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  sites TEXT NOT NULL DEFAULT '[]', rev INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  person TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, used INTEGER);
CREATE TABLE IF NOT EXISTS notes (
  project INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
  data TEXT NOT NULL, body TEXT NOT NULL, reply TEXT NOT NULL, done INTEGER NOT NULL,
  author TEXT, resolved INTEGER, seen INTEGER, archived INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (project, id));
CREATE TABLE IF NOT EXISTS assets (
  project INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
  type TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (project, name));
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, token INTEGER REFERENCES tokens(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
`;

export type Db = ReturnType<typeof openDb>;

/** Open (or create) the database. `file` ':memory:' gives a throwaway one (tests). */
export function openDb(file: string) {
  const db: DatabaseSync = new (sqlite().DatabaseSync)(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  db.exec(SCHEMA);

  const q = <T>(sql: string) => {
    const st = db.prepare(sql);
    return { get: (...a: unknown[]) => st.get(...(a as never[])) as T | undefined, all: (...a: unknown[]) => st.all(...(a as never[])) as T[], run: (...a: unknown[]) => st.run(...(a as never[])) };
  };
  const toProject = (r: { id: number; slug: string; name: string; sites: string; created: number }): Project =>
    ({ id: r.id, slug: r.slug, name: r.name, sites: JSON.parse(r.sites), created: r.created });

  const setting = q<{ value: string }>('SELECT value FROM settings WHERE key = ?');
  const setSetting = q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

  return {
    raw: db,
    close: () => db.close(),

    /** The admin key: created (and returned, the only time it is readable) when there is none, or on reset. */
    adminKey(reset = false): string | null {
      if (!reset && setting.get('admin')) return null;
      const key = secret('rha_');
      setSetting.run('admin', sha256(key));
      if (reset) q('DELETE FROM sessions WHERE token IS NULL').run();   // signed-in admins sign in again
      return key;
    },
    isAdminKey: (key: string) => setting.get('admin')?.value === sha256(key),

    projects: () => q<Parameters<typeof toProject>[0]>('SELECT * FROM projects ORDER BY name').all().map(toProject),
    project(slug: string): Project | null {
      const r = q<Parameters<typeof toProject>[0]>('SELECT * FROM projects WHERE slug = ?').get(slug);
      return r ? toProject(r) : null;
    },
    createProject(slug: string, name: string, sites: string[], now: number): Project {
      q('INSERT INTO projects (slug, name, sites, created) VALUES (?, ?, ?, ?)').run(slug, name, JSON.stringify(sites), now);
      return this.project(slug)!;
    },
    updateProject(id: number, name: string, sites: string[]) { q('UPDATE projects SET name = ?, sites = ? WHERE id = ?').run(name, JSON.stringify(sites), id); },
    deleteProject(id: number) { q('DELETE FROM projects WHERE id = ?').run(id); },
    bump(project: number) { q('UPDATE projects SET rev = rev + 1 WHERE id = ?').run(project); },
    rev: (project: number) => q<{ rev: number }>('SELECT rev FROM projects WHERE id = ?').get(project)?.rev ?? 0,

    tokens: (project: number) => q<Token>('SELECT id, project, person, kind, created, used FROM tokens WHERE project = ? ORDER BY person, id').all(project),
    /** A new token for `person`; the plain token is returned once and only its hash kept. */
    createToken(project: number, person: string, kind: Token['kind'], now: number): { token: string; id: number } {
      const token = secret('rht_');
      const r = q('INSERT INTO tokens (project, person, kind, hash, created) VALUES (?, ?, ?, ?, ?)').run(project, person, kind, sha256(token), now);
      return { token, id: Number(r.lastInsertRowid) };
    },
    deleteToken(project: number, id: number) { return q('DELETE FROM tokens WHERE project = ? AND id = ?').run(project, id).changes > 0; },
    /** The token's row, and when it was last used (written at most once a minute: overlays poll every few seconds). */
    tokenFor(token: string, now: number): Token | null {
      const t = q<Token>('SELECT id, project, person, kind, created, used FROM tokens WHERE hash = ?').get(sha256(token));
      if (t && (t.used ?? 0) < now - 60_000) q('UPDATE tokens SET used = ? WHERE id = ?').run(now, t.id);
      return t ?? null;
    },

    /** A UI session: `token` null for the admin, else the member token it was opened with. */
    createSession(token: number | null, now: number, days = 30): string {
      const id = secret('rhs_');
      q('DELETE FROM sessions WHERE expires < ?').run(now);
      q('INSERT INTO sessions (hash, token, expires) VALUES (?, ?, ?)').run(sha256(id), token, now + days * 86_400_000);
      return id;
    },
    session(id: string, now: number): { token: number | null } | null {
      return q<{ token: number | null }>('SELECT token FROM sessions WHERE hash = ? AND expires > ?').get(sha256(id), now) ?? null;
    },
    endSession(id: string) { q('DELETE FROM sessions WHERE hash = ?').run(sha256(id)); },
    tokenById: (id: number) => q<Token>('SELECT id, project, person, kind, created, used FROM tokens WHERE id = ?').get(id) ?? null,

    q,
  };
}
