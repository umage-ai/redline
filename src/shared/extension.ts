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
}

export interface RedlineApi {
  version: 1;
  addButton(b: RedlineButton): void;
  addPanelSection(s: RedlinePanelSection): void;
  on<E extends keyof RedlineEvents>(event: E, fn: (...args: RedlineEvents[E]) => void): () => void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  setMode(m: RedlineMode): void;
  togglePanel(open?: boolean): void;
  toast(message: string, error?: boolean): void;
  /** Notes for this page (this app), or all notes. */
  notes(scope?: 'page' | 'all'): Note[];
  /** The normalised page key notes are grouped by. */
  page(): string;
  /** Re-fetch notes now. */
  refresh(): Promise<void>;
  /** Re-render the bar and panel (after your button/section state changed). */
  render(): void;
}

export type RedlineExtension = (api: RedlineApi) => void | Promise<void>;
