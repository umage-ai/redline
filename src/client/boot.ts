// What the self-starting overlay (index.ts) reads before it mounts (D60): `window.redlineConfig`, set
// before the script loads, then data-* attributes on its own <script> tag, then the defaults. A host
// that drops in a plain script tag (no bundler, a CMS module route, an app under a path base) sets
// its API base here; with a bundler, `mount({ transport: httpTransport(base) })` does the same.

import { API_BASE } from '../shared/types.ts';
import type { RedlineApi } from '../shared/extension.ts';
import type { HttpTransportOptions } from './transport.ts';

/** `window.redlineConfig`: read once, when the self-starting script runs. */
export interface RedlineBootConfig {
  /**
   * The API's base: a path on this origin (`/app/__redline`) or a URL on another one. Default `/__redline`.
   * Script tag: `data-api`. The dev servers set it themselves under a custom `apiBase` or a .NET PathBase.
   */
  apiBase?: string;
  /** An API on another origin with cookie auth (D60): `'include'`. Script tag: `data-credentials="include"`. */
  credentials?: RequestCredentials;
  /** Headers for every API call, or a function asked before each (a bearer token from the host's login). No attribute. */
  headers?: HttpTransportOptions['headers'];
  /** Start inside an iframe too (D60; default off). Script tag: `data-allow-iframe`. The server's `allowInIframe` does it for every page. */
  allowInIframe?: boolean;
  /** Show the launcher (default: the server's `launcher`). `false` in a frame whose parent opens it (postMessage). Script tag: `data-launcher="false"`. */
  launcher?: boolean;
}

export interface Boot extends HttpTransportOptions { apiBase: string; allowInIframe?: boolean; launcher?: boolean }

const CREDENTIALS = ['omit', 'same-origin', 'include'];

/** The settings the self-starting script mounts with: `redlineConfig` first, then the script's data-*, then defaults. */
export function readBoot(cfg: RedlineBootConfig | undefined, data: Record<string, string | undefined> | undefined): Boot {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const d = data ?? {};
  const apiBase = (typeof c.apiBase === 'string' && c.apiBase.trim()) || d.api?.trim() || API_BASE;
  const boot: Boot = { apiBase: apiBase.replace(/\/+$/, '') };
  const credentials = [c.credentials, d.credentials?.trim()].find(v => typeof v === 'string' && CREDENTIALS.includes(v));
  if (credentials) boot.credentials = credentials as RequestCredentials;
  if (typeof c.headers === 'function' || (c.headers && typeof c.headers === 'object')) boot.headers = c.headers;
  const flag = (v: unknown, attr: string | undefined) => typeof v === 'boolean' ? v : attr === undefined ? undefined : attr.trim().toLowerCase() !== 'false';
  const frames = flag(c.allowInIframe, d.allowIframe);
  if (frames) boot.allowInIframe = true;
  const launcher = flag(c.launcher, d.launcher);
  if (launcher !== undefined) boot.launcher = launcher;
  return boot;
}

/** What a parent page may ask a framed overlay (D60): `postMessage({ redline: 'toggle' }, origin)`. */
export type FrameCommand = 'toggle' | 'open' | 'close' | 'comment' | 'text' | 'sketch' | 'notes';

/**
 * Lets the parent page open and close this frame's overlay (same origin only: a foreign page framing
 * the app must not drive it). Returns the remover.
 */
export function listenToParent(api: Pick<RedlineApi, 'isOpen' | 'open' | 'close' | 'setMode' | 'togglePanel'>): () => void {
  const onMessage = (e: MessageEvent) => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    const v = (e.data as { redline?: unknown } | null)?.redline;
    if (v === 'toggle') { if (api.isOpen()) api.close(); else api.open(); }
    else if (v === 'open') api.open();
    else if (v === 'close') api.close();
    else if (v === 'comment' || v === 'text' || v === 'sketch') api.setMode(v);
    else if (v === 'notes') { if (!api.isOpen()) api.open(); api.togglePanel(); }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** This script's own tag: `document.currentScript` is null in a module, so match it by URL. */
export function ownScript(url: string): HTMLScriptElement | null {
  const cur = document.currentScript;
  if (cur instanceof HTMLScriptElement) return cur;
  return Array.from(document.scripts).find(s => s.src === url) ?? null;
}
