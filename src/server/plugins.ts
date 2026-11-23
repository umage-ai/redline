// Server plugins (D70): opt-in packages that add routes and an overlay extension to the dev server,
// e.g. @umage.ai/redline-voice. A plugin gets the project's paths and the notes, through the same
// path the API takes (targets normalised, store-owned fields dropped, app and build set, hooks run),
// and answers `<base>/p/<name>/…` behind the API's guards (`network`, and `x-redline: 1` on writes).
//
//   import { voice } from '@umage.ai/redline-voice';
//   redline({ plugins: [voice({ transcribe: { url: 'http://localhost:8000/v1' } })] })

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NewNoteRequest, Note } from '../shared/types.ts';
import type { NotePatch } from './store.ts';

/** The notes, as the API handles them; `req` is the request that caused the call, when there is one. */
export interface PluginNotes {
  list(req?: IncomingMessage): Promise<(Note & { file?: string })[]>;
  get(id: string, req?: IncomingMessage): Promise<(Note & { file?: string }) | null>;
  /** Creates a note like `POST /notes` does: the page can't set store-owned fields; `app`, `build` set here; `onCreate` runs. */
  create(body: NewNoteRequest, req?: IncomingMessage): Promise<Note & { file?: string }>;
  /** Changes a note; `onUpdate` runs. Unlike `PATCH /notes/<id>` a plugin may set `meta` (replaced whole). */
  update(id: string, patch: NotePatch, req?: IncomingMessage): Promise<Note | null>;
}

export interface PluginContext {
  /** The project root (absolute) and the notes folder relative to it (`.redline`). */
  root: string;
  dir: string;
  /** `root` + `dir`, absolute: where a plugin keeps its own files (`.redline/<something>/`). */
  dirPath: string;
  /** Whether notes are the markdown files in `dirPath` (the default store), so files there sit next to them. */
  markdown: boolean;
  /** The API base (`/__redline`); the plugin's routes are under `<base>/p/<name>/`. */
  base: string;
  /** Monorepos: this dev server's app folder ("" at the root). */
  app: string;
  /** The dev server's own root (where its config is). */
  serverRoot: string;
  notes: PluginNotes;
}

export interface PluginRoutes {
  /**
   * Answers `<base>/p/<name>/<path>`; `path` starts with `/`. Writes (anything but GET/HEAD) only arrive
   * with `x-redline: 1`. `local`: the caller is this machine (`network` may have let others in).
   */
  handle?(req: IncomingMessage, res: ServerResponse, path: string, info: { local: boolean }): void | Promise<void>;
  /** Overlay extension URLs to load (D21), e.g. `${base}/p/<name>/extension.js` served by `handle`. */
  extensions?: string[];
}

export interface RedlinePlugin {
  /** Lowercase letters, digits and dashes: the route segment. Two plugins can't share one. */
  name: string;
  setup(ctx: PluginContext): PluginRoutes;
}

export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
