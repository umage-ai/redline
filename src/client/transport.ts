// How the overlay talks to its note store. The default is the dev server's `/__redline` API
// (handler.ts); an embedding product passes its own object (D49). To change one call, wrap
// the default: `{ ...httpTransport(), create: r => base.create(withTicket(r)) }`.

import type { Note, NewNoteRequest, NotesResponse } from '../shared/types.ts';
import { API_BASE } from '../shared/types.ts';
import type { Token } from '../server/edit.ts';
import type { OverlayConfig } from './options.ts';

export type StoredNote = Note & { file?: string };

export interface Inspection { tokens: Token[]; braces: boolean; selfClose: boolean; spell?: Record<string, string> }
export type EditResult = { ok: true; file: string; line?: number; inspect?: Inspection } | { ok: false; reason: string };
/** What text mode sends to a source writer (D20). */
export interface EditRequest {
  from?: string; to?: string; html?: string; tag: string; url: string;
  source?: unknown; nth?: { index: number; count: number }; cms?: unknown;
}

export interface RedlineTransport {
  /** The overlay's settings (hotkey, labels, prompt…). Anything left out keeps its default. */
  config(): Promise<Partial<OverlayConfig>>;
  /** All notes; `null` when nothing changed since `version` (an ETag). Throw when unreachable. */
  load(version?: string): Promise<NotesResponse | null>;
  create(req: NewNoteRequest): Promise<StoredNote>;
  update(id: string, patch: Partial<Note>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  /** The URL an image line in a note (`assets/<id>.png`) is shown from. */
  assetUrl(rel: string): string;
  /** Direct source edits (D20). Leave it out and text mode only saves notes. */
  edit?(req: EditRequest, mode: 'inspect' | 'dry' | 'apply'): Promise<EditResult>;
  /** Adds a message to the note's thread (D50). Leave it out and cards show no reply box. */
  message?(id: string, body: string): Promise<unknown>;
  /**
   * A change feed (D41): call `changed` when notes changed elsewhere, `live` with whether the feed
   * is up (polling slows to a backstop while it is). Only used when the config says `events`.
   * Returns the unsubscribe.
   */
  subscribe?(changed: () => void, live: (up: boolean) => void): () => void;
}

/** The dev server's API (or any server speaking it, docs/PROTOCOL.md) at `base`. */
export function httpTransport(base = API_BASE): RedlineTransport {
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  }
  return {
    config: async () => (await fetch(`${base}/config`)).json(),
    async load(version) {
      const r = await fetch(`${base}/notes`, { headers: version ? { 'if-none-match': `"${version}"` } : {}, cache: 'no-store' });
      if (r.status === 304) return null;
      return r.json();
    },
    create: req => api('POST', '/notes', req),
    update: (id, patch) => api('PATCH', `/notes/${id}`, patch),
    remove: id => api('DELETE', `/notes/${id}`),
    // A thread reply (D52): a patch that appends to the note's messages.
    message: (id, body) => api('PATCH', `/notes/${id}`, { message: { body } }),
    assetUrl: rel => `${base}/assets/${rel.split('/').pop()}`,
    edit: (req, mode) => api('POST', mode === 'apply' ? '/edit' : mode === 'dry' ? '/edit?dry=1' : '/edit?inspect=1', req),
    subscribe(changed, live) {
      if (typeof EventSource !== 'function') return () => {};
      const es = new EventSource(`${base}/events`);
      es.addEventListener('open', () => live(true));
      es.addEventListener('change', () => changed());
      es.addEventListener('error', () => live(false));
      return () => es.close();
    },
  };
}
