// The overlay's extension API (D21). An extension is a browser ES module whose default
// export receives this API; list its path in the `extensions` option, or push a function
// onto `window.redlineExtensions` from any script (order doesn't matter).
//
//   // redline.ext.js
//   export default (rl) => {
//     rl.addButton({ id: 'present', label: 'Present', key: 'f', title: 'Full screen', onClick: () => rl.close() });
//     rl.on('noteCreated', n => console.log('new note', n.id));
//   };

import type { Note } from './types.ts';

export type RedlineMode = 'idle' | 'comment' | 'text' | 'sketch';

export interface RedlineButton {
  id: string;
  label: string;
  /** Single key that triggers it while the overlay is open (the built-in C/T/S/K/N win). */
  key?: string;
  title?: string;
  onClick(): void;
  /** Highlighted like an active mode when this returns true. */
  active?(): boolean;
}

export interface RedlinePanelSection {
  id: string;
  title?: string;
  /** Called on every panel render with an empty element inside the overlay's shadow root. */
  render(el: HTMLElement): void;
}

export interface RedlineEvents {
  open: [];
  close: [];
  mode: [RedlineMode];
  /** The note list changed (a save here, or an agent editing the store). */
  notes: [Note[]];
  noteCreated: [Note];
  /** A text edit was written straight to source. */
  sourceWritten: [{ file: string; line?: number; from: string; to: string }];
  /** The notes panel opened, closed or changed width (v2). Lay the page out beside it with `width`. */
  panel: [RedlinePanelState];
  /** The page key changed: a route change, or `setPageKey` (v2). */
  page: [string];
}

export interface RedlinePanelState {
  open: boolean;
  /** Pixels the panel covers at the right edge; 0 when closed. */
  width: number;
}

/**
 * Custom page key (v2): gets the location and the built-in key; returns the key to group notes
 * by, or null/undefined to keep the built-in one.
 */
export type RedlinePageKey = (loc: Location, builtIn: string) => string | null | undefined;

export interface RedlineApi {
  /** 2 adds removeButton, panelState, setPageKey and the panel/page events. Check `rl.version >= 2`. */
  version: 2;
  /** Adds a toolbar button; a button with the same id is replaced (use that to update one). */
  addButton(b: RedlineButton): void;
  /** Removes a toolbar button added with addButton (v2). */
  removeButton(id: string): void;
  addPanelSection(s: RedlinePanelSection): void;
  on<E extends keyof RedlineEvents>(event: E, fn: (...args: RedlineEvents[E]) => void): () => void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  setMode(m: RedlineMode): void;
  togglePanel(open?: boolean): void;
  /** Whether the notes panel is open and how wide it is (v2). */
  panelState(): RedlinePanelState;
  toast(message: string, error?: boolean): void;
  /** Notes for this page (this app), or all notes. */
  notes(scope?: 'page' | 'all'): Note[];
  /** The normalised page key notes are grouped by. */
  page(): string;
  /** Group notes by your own key, e.g. one key per deck regardless of the slide hash (v2). null restores the default. */
  setPageKey(fn: RedlinePageKey | null): void;
  /** Re-fetch notes now. */
  refresh(): Promise<void>;
  /** Re-render the bar and panel (after your button/section state changed). */
  render(): void;
}

export type RedlineExtension = (api: RedlineApi) => void | Promise<void>;
