// Redline overlay, as the dev server injects it into every HTML page: starts itself once per
// window against the dev server's /__redline API, or the base the page sets (`window.redlineConfig.apiBase`
// or `data-api` on the script tag, boot.ts, D60), with credentials or headers for an API on another origin.
// Inside an iframe only when the host opts in (`allowInIframe`, D60). Modes: comment (pin a note on an
// element), text (rewrite text in place → a text-change note), sketch (draw on the page).
// Notes are stored by the dev server as markdown under .redline/ for an agent to work through.
// To start the overlay yourself, import `mount` from '@umage.ai/redline/overlay' (mount.ts, D49).

import type { RedlineExtension } from '../shared/extension.ts';
import { listenToParent, ownScript, readBoot, type RedlineBootConfig } from './boot.ts';
import { inFrame } from './dom.ts';
import { captureErrors } from './errors.ts';
import { mount } from './mount.ts';
import { httpTransport } from './transport.ts';

declare global {
  interface Window { __redline?: boolean; redlineConfig?: RedlineBootConfig; redlineExtensions?: { push(...fns: RedlineExtension[]): unknown } }
}

if (!window.__redline) {
  window.__redline = true;
  const { apiBase, allowInIframe, launcher, ...auth } = readBoot(window.redlineConfig, ownScript(import.meta.url)?.dataset);
  const transport = httpTransport(apiBase, auth);
  const framed = inFrame();
  // From the script's first moment, so errors during the app's start-up are attached too.
  const errors = !framed || allowInIframe ? captureErrors() : null;
  const start = () => void mount({ captureErrors: errors?.list ?? true, transport, ...(launcher === undefined ? {} : { config: { launcher } }) })
    .then(rl => { if (framed) listenToParent(rl.api); });
  const ready = (fn: () => void) => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); };
  if (!framed || allowInIframe) ready(start);
  // A frame without the page's opt-in asks the server's (allowInIframe in /config); otherwise nothing runs here.
  else transport.config().then(c => { if (c?.allowInIframe === true) ready(start); }, () => { /* no server: no overlay */ });
}
