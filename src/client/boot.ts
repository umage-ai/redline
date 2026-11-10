// What the self-starting overlay (index.ts) reads before it mounts (D60): `window.redlineConfig`, set
// before the script loads, then data-* attributes on its own <script> tag, then the defaults. A host
// that drops in a plain script tag (no bundler, a CMS module route, an app under a path base) sets
// its API base here; with a bundler, `mount({ transport: httpTransport(base) })` does the same.

import { API_BASE } from '../shared/types.ts';

/** `window.redlineConfig`: read once, when the self-starting script runs. */
export interface RedlineBootConfig {
  /**
   * The API's base: a path on this origin (`/app/__redline`) or a URL on another one. Default `/__redline`.
   * Script tag: `data-api`. The dev servers set it themselves under a custom `apiBase` or a .NET PathBase.
   */
  apiBase?: string;
}

/** The settings the self-starting script mounts with: `redlineConfig` first, then the script's data-*, then defaults. */
export function readBoot(cfg: RedlineBootConfig | undefined, data: Record<string, string | undefined> | undefined): Required<Pick<RedlineBootConfig, 'apiBase'>> {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const d = data ?? {};
  const apiBase = (typeof c.apiBase === 'string' && c.apiBase.trim()) || d.api?.trim() || API_BASE;
  return { apiBase: apiBase.replace(/\/+$/, '') };
}

/** This script's own tag: `document.currentScript` is null in a module, so match it by URL. */
export function ownScript(url: string): HTMLScriptElement | null {
  const cur = document.currentScript;
  if (cur instanceof HTMLScriptElement) return cur;
  return Array.from(document.scripts).find(s => s.src === url) ?? null;
}
