// What the self-starting overlay (index.ts) reads before it mounts (D60): `window.redlineConfig`, set
// before the script loads, then data-* attributes on its own <script> tag, then the defaults. A host
// that drops in a plain script tag (no bundler, a CMS module route, an app under a path base) sets
// its API base here; with a bundler, `mount({ transport: httpTransport(base) })` does the same.

import { API_BASE } from '../shared/types.ts';
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
}

export interface Boot extends HttpTransportOptions { apiBase: string }

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
  return boot;
}

/** This script's own tag: `document.currentScript` is null in a module, so match it by URL. */
export function ownScript(url: string): HTMLScriptElement | null {
  const cur = document.currentScript;
  if (cur instanceof HTMLScriptElement) return cur;
  return Array.from(document.scripts).find(s => s.src === url) ?? null;
}
