// The overlay's extension API (D21). An extension is a browser ES module whose default
// export receives this API; list its path in the `extensions` option, or push a function
// onto `window.redlineExtensions` from any script (order doesn't matter).
//
//   // redline.ext.js
//   export default (rl) => {
//     rl.addButton({ id: 'present', label: 'Present', key: 'f', title: 'Full screen', onClick: () => rl.close() });
//     rl.on('noteCreated', n => console.log('new note', n.id));
//   };

import type { NewNoteRequest, Note } from './types.ts';

/** The built-in modes, or an extension's pick mode as `ext:<id>` (v4). */
export type RedlineMode = 'idle' | 'comment' | 'text' | 'sketch' | `ext:${string}`;

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

/** A spot in the toolbar for your own element (v3): a workspace chip, an account menu. */
export interface RedlineSlot {
  id: string;
  /** Called on every toolbar render with an empty element inside the overlay's shadow root. */
  render(el: HTMLElement): void;
}

/**
 * A blocking step before notes load (v3): render into `el` (sign-in, a workspace picker), and
 * resolve to let the reviewer in. A rejection shows its message and asks again on the next open.
 */
export type RedlineGate = (el: HTMLElement) => void | Promise<void>;

/**
 * Runs before a note is saved (v4): return a changed request, nothing to keep it, or `false` to
 * cancel the save (the draft stays open; say why with `rl.toast`). Hooks run in the order added.
 */
export type RedlineBeforeSave = (req: NewNoteRequest) => NewNoteRequest | void | false | Promise<NewNoteRequest | void | false>;

/** Your own element on every note card (v4), e.g. an expiry chip from `note.meta`. */
export interface RedlineCardDecorator {
  id: string;
  /** Called on every panel render with the note and an empty element at the end of its card. */
  render(note: Note, el: HTMLElement): void;
}

/** A button among each card's actions (v4). */
export interface RedlineCardAction {
  id: string;
  /** A short label or symbol; `title` is the tooltip. */
  label: string;
  title?: string;
  /** Only on cards where this returns true (default: every card). */
  show?(note: Note): boolean;
  onClick(note: Note): void;
}

/** What a pin shows (v4): its label (default the note's number) and colour. Return null for the default. */
export type RedlinePinStyle = (note: Note) => { label?: string; color?: string } | null | undefined;

/**
 * An extension mode (v4): a toolbar button that picks an element like Comment does (hover outline,
 * Alt+click = parent, Shift+click = whole page; the app never sees the click) and hands the pick
 * to `onPick`. The mode ends after one pick unless `stay` is set.
 */
export interface RedlineModeDef {
  id: string;
  label: string;
  /** Single key that toggles it while the overlay is open (the built-in keys win). */
  key?: string;
  title?: string;
  stay?: boolean;
  onPick(pick: { el: Element | null; whole: boolean; x: number; y: number }): void;
  onStart?(): void;
  onStop?(): void;
}

/**
 * A drag-shaped sketch tool (v4), next to box/arrow/pen/text: the reviewer drags from (x1, y1) to
 * (x2, y2) and `svg` draws it (viewport px; `color` is the picked colour, `halo` its contrast
 * outline). The result is part of the saved sketch SVG, so it must be self-contained markup.
 */
export interface RedlineSketchTool {
  id: string;
  label: string;
  svg(box: { x1: number; y1: number; x2: number; y2: number }, color: string, halo: string): string;
}

/**
 * A floating window in the overlay (v5): a header with its title, your controls, and close; a body
 * you fill. Dragged by its header, resized from its corner, both kept per viewer. It stays up while
 * the overlay is closed (an agent's terminal, a log), until closed itself.
 */
export interface RedlineWindowDef {
  id: string;
  title: string;
  /** Called once, when first shown: `body` is yours (inside the overlay's shadow root), `controls` sits in the header before ✕. */
  render(body: HTMLElement, controls: HTMLElement): void;
  /** Initial size in px (default 560 × 380); clamped to the viewport. */
  width?: number;
  height?: number;
  onShow?(): void;
  onHide?(): void;
  /** After a resize, with the body's new size. */
  onResize?(size: { width: number; height: number }): void;
}

export interface RedlineWindow {
  show(): void;
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  setTitle(title: string): void;
  remove(): void;
}

/**
 * A toolbar of your own (v5), shown in place of the main one the way sketch shows its tools: the
 * icon (the drag handle), your element, and ✕ back to the main toolbar (Esc too). The live outline,
 * position and drag carry over. An agent's controls, a review checklist, a presenter's remote.
 */
export interface RedlineToolbarDef {
  id: string;
  /** Called on every toolbar render while shown, with an empty element inside the overlay's shadow root. */
  render(el: HTMLElement): void;
  /** Like the overlay's hotkey (`alt+shift+a`): opens the overlay in this toolbar from anywhere; pressed there, closes it. */
  hotkey?: string;
  /** Hover text for the ✕ that goes back (default "Back to the toolbar (Esc)"). */
  backTitle?: string;
  onShow?(): void;
  onHide?(): void;
}

export interface RedlineToolbar {
  /** Opens the overlay (if closed) in this toolbar; a running mode ends. */
  show(): void;
  /** Back to the main toolbar. */
  hide(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Re-render it (after your state changed). */
  render(): void;
  remove(): void;
}

/**
 * A live indicator (v5), e.g. an agent working, waiting for you, or done, in the same language on
 * both: as `toolbar` says, the open toolbar's outline (the first such status wins; `title` on hover
 * over the bar), a dot after its brand (the default), or nothing; as `launcher` says, a ring around
 * the closed overlay's launcher (the first such status wins), a small dot (the default), or nothing.
 */
export interface RedlineStatus {
  color: string;
  /** Hover text. */
  title?: string;
  /** On the open toolbar: `'outline'` (its border), `'dot'` (default, after the brand), or `false`. */
  toolbar?: 'outline' | 'dot' | false;
  /** On the closed overlay's launcher: `'ring'` around it, `'dot'` (default), or `false` (toolbar only). */
  launcher?: 'ring' | 'dot' | false;
  /** Glow in and out (waiting for someone). */
  pulse?: boolean;
  /** Busy: a turning arc on the ring and dots, a light sweeping along the toolbar's outline. */
  spin?: boolean;
  /** A click on the dot (the launcher itself keeps opening the overlay). */
  onClick?(): void;
}

/**
 * The launcher's bubble (v5): text (a number of open notes by default) for its top-right corner,
 * or null/'' for none. Gets the open notes on this page.
 */
export type RedlineBadge = (open: number) => string | number | null | undefined;

/** Which store call failed (v4). */
export type RedlineOp = 'load' | 'create' | 'update' | 'remove' | 'message';

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
  /**
   * A store call failed (v4): `load` once per failure streak (polling goes on quietly), the others
   * each time (the reviewer also sees a toast). Use it for 401/expired handling, e.g. `rl.gate(signIn)`.
   */
  error: [{ op: RedlineOp; error: Error; id?: string }];
  /** A note was changed from this overlay (v4): done, status, body… (`seen` acknowledgements excluded). */
  noteUpdated: [{ id: string; patch: Partial<Note> }];
  /** A note was deleted from this overlay (v4). */
  noteRemoved: [{ id: string }];
  /** A reply was added to a note's thread from this overlay (v4). */
  messageSent: [{ id: string; body: string }];
  /** An extension set or cleared a status (v5): e.g. react to the agent panel's `agent` status. */
  status: [{ id: string; status: RedlineStatus | null }];
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
  /**
   * 2 adds removeButton, panelState, setPageKey and the panel/page events; 3 adds addSlot,
   * removeSlot and gate; 4 adds beforeSave, card decorators and actions, setPinStyle, addMode,
   * addSketchTool and the error/noteUpdated/noteRemoved/messageSent events; 5 adds addWindow,
   * addToolbar, setStatus, statuses, setBadge and the status event. Check `rl.version >= 5`.
   */
  version: 5;
  /** Adds a toolbar button; a button with the same id is replaced (use that to update one). */
  addButton(b: RedlineButton): void;
  /** Removes a toolbar button added with addButton (v2). */
  removeButton(id: string): void;
  addPanelSection(s: RedlinePanelSection): void;
  /** Adds (or, same id, replaces) a toolbar slot after the buttons (v3). */
  addSlot(s: RedlineSlot): void;
  removeSlot(id: string): void;
  /**
   * Locks the overlay behind `gate` (v3): notes are dropped and the modes are off until it resolves
   * (sign-out, switching workspace). It runs now when the overlay is open, else on the next open.
   */
  gate(gate: RedlineGate): void;
  /** Whether a gate is waiting to be passed (v3). */
  locked(): boolean;
  /** Runs `fn` before every save (v4); returns the remover. */
  beforeSave(fn: RedlineBeforeSave): () => void;
  /** Adds (or, same id, replaces) an element on every card (v4). */
  addCardDecorator(d: RedlineCardDecorator): void;
  removeCardDecorator(id: string): void;
  /** Adds (or, same id, replaces) a button among each card's actions (v4). */
  addCardAction(a: RedlineCardAction): void;
  removeCardAction(id: string): void;
  /** Sets how pins look (v4); null restores numbers in the type's colour. */
  setPinStyle(fn: RedlinePinStyle | null): void;
  /** Adds (or, same id, replaces) a pick mode with its toolbar button (v4); `setMode('ext:<id>')` starts it. */
  addMode(m: RedlineModeDef): void;
  removeMode(id: string): void;
  /** Adds (or, same id, replaces) a sketch tool (v4); it gets the next free number key (5–9). */
  addSketchTool(t: RedlineSketchTool): void;
  removeSketchTool(id: string): void;
  /** Adds a floating window (v5; same id: replaced). Hidden until `show()`. */
  addWindow(w: RedlineWindowDef): RedlineWindow;
  /** Adds a toolbar shown in place of the main one (v5; same id: replaced). Hidden until `show()`. */
  addToolbar(t: RedlineToolbarDef): RedlineToolbar;
  /** Sets (or, null, clears) a live indicator under `id` (v5); other extensions hear the `status` event. */
  setStatus(id: string, status: RedlineStatus | null): void;
  /** The indicators set now (v5). */
  statuses(): Record<string, RedlineStatus>;
  /** The launcher's bubble (v5): your text, `false` for none, `null` for the default (open notes on the page). */
  setBadge(fn: RedlineBadge | false | null): void;
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
