// The state one mounted overlay shares between its parts (bar, panel, pins, draft, text, sketch,
// keys). Each part is a function `(ctx) => { its actions }`; mount() assigns them all onto ctx,
// so a part calls another through ctx and never imports it.

import type { Note, NoteType } from '../shared/types.ts';
import type { LabelDef } from '../shared/labels.ts';
import type { RedlineButton, RedlineEvents, RedlineGate, RedlinePanelSection, RedlinePanelState, RedlineSlot } from '../shared/extension.ts';
import type { Life, Store } from './dom.ts';
import type { Shield } from './shield.ts';
import type { Mark } from './capture.ts';
import type { SketchLayer } from './sketch.ts';
import type { OverlayConfig, StatusDef } from './options.ts';
import type { Translate } from './strings.ts';
import type { Inspection, RedlineTransport, StoredNote } from './transport.ts';

export type Mode = 'idle' | 'comment' | 'text' | 'sketch';

export interface Draft {
  type: NoteType; el?: Element | null; whole?: boolean; x: number; y: number;
  from?: string; to?: string; sketch?: SketchLayer; editor?: HTMLElement;
  rich?: Inspection; html?: string;   // rich text edits (D20): the source tokens and the new source content
  label?: string;                     // the chip picked in the popover (D46)
}

/** Kept in sessionStorage, so a reload comes back to the same view. */
export interface ViewState { open: boolean; mode: Mode; panel: boolean; scope: 'page' | 'all'; showDone: boolean }

export interface Layers {
  launcher: HTMLButtonElement; hl: HTMLElement; hlLabel: HTMLElement; pins: HTMLElement; tip: HTMLElement;
  bar: HTMLElement; panel: HTMLElement; popLayer: HTMLElement; toast: HTMLElement; gate: HTMLElement;
}

export interface Ctx {
  /* fixed for the overlay's life */
  config: OverlayConfig;
  transport: RedlineTransport;
  store: Store;
  life: Life;
  shield: Shield;
  host: HTMLElement;
  shadow: ShadowRoot;
  ui: HTMLElement;
  el: Layers;
  /** This app's notes are pinned and numbered; others are only listed (D17). */
  app: string;
  /** Storage prefix and `data-<ns>-open` trigger attribute (MountOptions.namespace). */
  ns: string;
  errors(): string[];
  /** UI text (strings.ts), with the caller's replacements. */
  t: Translate;
  shoot(mark: Mark): Promise<string | undefined>;

  /* changing state */
  state: ViewState;
  notes: StoredNote[];
  version: string;
  draft: Draft | null;
  page: string;
  focusId: string | null;
  /** A save or source write is running: picking pauses. */
  busy: boolean;
  ext: { buttons: RedlineButton[]; sections: RedlinePanelSection[]; slots: RedlineSlot[] };
  /** A gate waiting to be passed (D50): no notes, no modes. `running`: the one on screen. */
  gate: { fn: RedlineGate | null; running: RedlineGate | null };

  /* core (mount.ts) */
  persist(): void;
  emit<E extends keyof RedlineEvents>(e: E, ...args: RedlineEvents[E]): void;
  poll(force?: boolean): Promise<void>;
  setOpen(v: boolean): void;
  setMode(m: Mode): void;
  renderAll(): void;
  releaseTextFocus(): void;
  checkPage(): boolean;
  pageNotes(p?: string, a?: string): StoredNote[];
  numberOf(n: Note): number;
  openCount(): number;
  isResolved(n: Note): boolean;
  markSeen(n: Note): void;
  statusOf(n: Note): StatusDef | undefined;
  locked(): boolean;
  lock(gate: RedlineGate): void;

  /* toast.ts */
  toast(msg: string, err?: boolean, ms?: number): void;
  savingNotice(): () => void;
  /* bar.ts */
  renderBar(): void;
  renderLauncher(): void;
  syncPanel(): void;
  panelState(): RedlinePanelState;
  showHl(el: Element, label: string | null, cls?: string): void;
  hideHl(): void;
  /* drag.ts */
  placeLauncher(): void;
  placeBar(): void;
  /* pins.ts */
  renderPins(): void;
  targetOf(n: Note): Element | null;
  /* panel.ts */
  renderPanel(force?: boolean): void;
  togglePanel(v?: boolean): void;
  /* draft.ts */
  openDraft(d: Draft): void;
  cancelDraft(): void;
  renderPop(): void;
  placePop(): void;
  labelDef(name?: string): LabelDef | undefined;
  tinted<T extends HTMLElement>(el: T, color?: string): T;
  /* text.ts */
  startTextEdit(block: Element): Promise<void>;
  /* sketch-tools.ts */
  startSketch(): void;
  endSketch(keep: boolean): void;
  renderTools(): void;
  /** A key while sketching; true when it was the sketch's. */
  sketchKey(e: KeyboardEvent): boolean;
}

/** One overlay part: gets the shared context, returns the actions it provides. */
export type Part<K extends keyof Ctx> = (ctx: Ctx) => Pick<Ctx, K>;

export const ICON = `<svg viewBox="0 0 24 24" fill="none" style="stroke:var(--ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/><path d="M14 20h6"/></svg>`;
