// The public shape of `mount()` (D49): what an embedding product can set or replace.

import type { LabelDef } from '../shared/labels.ts';
import type { PageKeyMode } from '../shared/page.ts';
import type { LauncherPosition } from '../shared/place.ts';
import type { RedlineApi, RedlineExtension, RedlineGate } from '../shared/extension.ts';
import type { RedlineStrings } from './strings.ts';
import type { Mark } from './capture.ts';
import type { RedlineTransport } from './transport.ts';

/** Settings the overlay reads, normally from the dev server's `/__redline/config`. */
export interface OverlayConfig {
  hotkey: string;
  /**
   * The floating button bottom-right while closed. false hides it: open the overlay with the hotkey,
   * a `data-redline-open` element on the page, or `api.open()`.
   */
  launcher: boolean;
  /**
   * The launcher, the toolbar and the sketch tools can be moved (D51): the launcher by dragging it,
   * the bars by their icon on the left (up and down only when they span the width, as on phones).
   * Kept per viewer; double-clicking an icon puts them all back. The gate and toasts sit next to a
   * moved toolbar. Default true (since 0.10); false pins them.
   */
  draggable?: boolean;
  /** The launcher's size: 'small' (26 px), 'medium' (32 px, default), 'large' (40 px), or px (20–64). */
  launcherSize?: 'small' | 'medium' | 'large' | number | string;
  /** Where the launcher sits: `'bottom-right'` (default), `'top-left 24'`, `'bottom-left 24 80'` (px from the edges, x then y), or `{ x, y, offsetX, offsetY }`. */
  launcherPosition?: LauncherPosition;
  labels?: LabelDef[];
  /** The "copy prompt for your agent" text; false hides it, a string replaces it ({open}, {page}). */
  prompt?: string | false;
  /** Where notes are kept, shown in the panel ("Saved → …"). */
  dir: string;
  guide?: string | null;
  /** Monorepo app folder: only this app's notes are pinned (D17). */
  app?: string;
  /** Offer "Apply to file" for text edits (needs `transport.edit`). */
  directEdit?: boolean;
  /** Extension module URLs to import (D21). */
  extensions?: string[];
  pageKey?: PageKeyMode;
  /** The transport has a change feed (`subscribe`). */
  events?: boolean;
  /**
   * A product's own note statuses (D50), in menu order. Set: each card gets a status menu instead of
   * the done button; picking one patches `{ status, done }` with the status's `done`.
   */
  statuses?: StatusDef[];
  /** UI text to replace (strings.ts lists every key); `{name}` placeholders are filled in. */
  strings?: Partial<RedlineStrings>;
}

export interface StatusDef {
  id: string;
  /** Shown in the menu and on the card; default the id. */
  label?: string;
  /** Chip colour (any CSS colour). */
  color?: string;
  /** This status closes the note: `done` is set with it, and it hides with "show done" off. */
  done?: boolean;
}

export interface ScreenshotRequest extends Mark {
  /** The overlay's host element; leave it out of the shot. */
  host: HTMLElement;
}

export interface MountOptions {
  /** Where notes come from and go to. Default: `httpTransport()` (the dev server's `/__redline`). */
  transport?: RedlineTransport;
  /** Merged over what `transport.config()` returns. */
  config?: Partial<OverlayConfig>;
  /**
   * Console errors attached to notes. true (default): listen from mount on, and stop at unmount.
   * A function: your own list (you started listening earlier, or in another world). false: none.
   */
  captureErrors?: boolean | (() => string[]);
  /**
   * Takes the screenshot as a PNG data URL (undefined: none). Gets the built-in one as `next`, so
   * it can wrap it, or replace it (a strict CSP may force capture into an extension's worker).
   */
  screenshot?: (req: ScreenshotRequest, next: (req: ScreenshotRequest) => Promise<string | undefined>) => Promise<string | undefined>;
  /** 'closed' for a store-published browser extension. Default 'open'. */
  shadowMode?: ShadowRootMode;
  /** The host element's tag. Default `redline-root`. */
  hostTag?: string;
  /**
   * Prefix for storage keys (`<ns>:shot`) and the global extension queue (`window.<ns>Extensions`),
   * so two overlays on one page don't share state. Default `redline`.
   */
  namespace?: string;
  /** Extensions to run once mounted, besides `config.extensions` and the global queue. */
  extensions?: RedlineExtension[];
  /** UI text to replace; wins over `config.strings`. */
  strings?: Partial<RedlineStrings>;
  /**
   * Runs before notes load (sign-in, a workspace picker, a name prompt), the first time the overlay
   * opens: it gets an empty element in the overlay to render into, and resolving lets the reviewer
   * in. Until then the modes are off and nothing is fetched. `api.gate()` locks it again later.
   */
  gate?: RedlineGate;
  /** CSS custom properties on the host, e.g. `{ '--ink': '#0a84ff' }` (see styles.ts for the tokens). */
  theme?: Record<string, string>;
}

export interface RedlineHandle {
  api: RedlineApi;
  /** Removes the overlay and every listener, timer and feed it started. */
  unmount(): void;
}
