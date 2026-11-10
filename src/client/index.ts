// Redline overlay, as the dev server injects it into every HTML page: starts itself once per
// page (never inside iframes) against the dev server's /__redline API, or the base the page sets
// (`window.redlineConfig.apiBase` or `data-api` on the script tag, boot.ts, D60). Modes: comment (pin
// a note on an element), text (rewrite text in place → a text-change note), sketch (draw on the page).
// Notes are stored by the dev server as markdown under .redline/ for an agent to work through.
// To start the overlay yourself, import `mount` from '@umage.ai/redline/overlay' (mount.ts, D49).

import type { RedlineExtension } from '../shared/extension.ts';
import { ownScript, readBoot, type RedlineBootConfig } from './boot.ts';
import { captureErrors } from './errors.ts';
import { mount } from './mount.ts';
import { httpTransport } from './transport.ts';

declare global {
  interface Window { __redline?: boolean; redlineConfig?: RedlineBootConfig; redlineExtensions?: { push(...fns: RedlineExtension[]): unknown } }
}

if (!window.__redline && window.top === window) {
  window.__redline = true;
  // From the script's first moment, so errors during the app's start-up are attached too.
  const errors = captureErrors();
  const boot = readBoot(window.redlineConfig, ownScript(import.meta.url)?.dataset);
  const start = () => void mount({ captureErrors: errors.list, transport: httpTransport(boot.apiBase) });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
