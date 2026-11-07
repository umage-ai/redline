// Console errors seen on the page, attached to notes (the last five). The auto-started overlay
// begins listening when its script loads, so errors from the app's start-up are kept too.

import { clip } from '../shared/text.ts';

export interface ErrorCapture { list(): string[]; stop(): void }

function safeJson(x: unknown) { try { return JSON.stringify(x); } catch { return String(x); } }

/** Patches console.error and listens for uncaught errors; `stop()` undoes both. */
export function captureErrors(max = 10): ErrorCapture {
  const errors: string[] = [];
  const push = (s: string) => { errors.push(clip(s, 300)); if (errors.length > max) errors.shift(); };
  const orig = console.error;
  const patched = (...a: unknown[]) => {
    push(a.map(x => (x instanceof Error ? x.message : typeof x === 'string' ? x : safeJson(x))).join(' '));
    orig.apply(console, a);
  };
  const onError = (e: ErrorEvent) => push(e.message);
  const onRejection = (e: PromiseRejectionEvent) => push('Unhandled rejection: ' + String((e.reason as Error)?.message ?? e.reason));
  console.error = patched;
  addEventListener('error', onError);
  addEventListener('unhandledrejection', onRejection);
  return {
    list: () => errors.slice(),
    stop() {
      if (console.error === patched) console.error = orig;   // someone patched it after us: leave theirs
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onRejection);
    },
  };
}
