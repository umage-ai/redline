// Small DOM helpers the overlay is built from, and `Life`: everything a mounted overlay
// registers (listeners, timers, observers) so `unmount()` can take all of it away again.

type Kid = Node | string | null | undefined | false;

/** `h('button', { class: 'on', onclick }, 'Label')`. `html` sets innerHTML: only for markup the overlay wrote itself. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) setProp(el, k, v);
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function setProp(el: HTMLElement, k: string, v: unknown) {
  if (v === undefined || v === null || v === false) return;
  if (k === 'html') el.innerHTML = v as string;
  else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
  else if (k === 'class') el.className = v as string;
  else el.setAttribute(k, v === true ? '' : String(v));
}

export const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Per-viewer settings under `<namespace>:` (localStorage) and the open/mode state (sessionStorage). */
export function storage(ns: string) {
  return {
    get: (k: string, d: string) => { try { return localStorage.getItem(`${ns}:${k}`) ?? d; } catch { return d; } },
    set: (k: string, v: string) => { try { localStorage.setItem(`${ns}:${k}`, v); } catch { /* private mode */ } },
    session: <T,>(d: T): T => { try { return { ...d, ...JSON.parse(sessionStorage.getItem(`${ns}:state`) ?? '{}') }; } catch { return d; } },
    saveSession: (v: unknown) => { try { sessionStorage.setItem(`${ns}:state`, JSON.stringify(v)); } catch { /* ignore */ } },
  };
}
export type Store = ReturnType<typeof storage>;

/** What a mounted overlay holds on to; `end()` releases it all, newest first. */
export class Life {
  private fns: (() => void)[] = [];
  ended = false;
  add(fn: () => void) { if (this.ended) fn(); else this.fns.push(fn); }
  on<T extends EventTarget>(target: T | null | undefined, type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions) {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    this.add(() => target.removeEventListener(type, fn, opts));
  }
  every(fn: () => void, ms: number) { const id = setInterval(fn, ms); this.add(() => clearInterval(id)); }
  end() {
    this.ended = true;
    for (const fn of this.fns.splice(0).reverse()) { try { fn(); } catch (err) { console.warn('[redline] unmount step failed:', err); } }
  }
}

/** Extension and hook code must never break the overlay. */
export function safely<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (err) { console.warn('[redline] extension failed:', err); return fallback; }
}

const editable = (n: unknown) => n instanceof HTMLElement && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
/**
 * The key goes into a text field: the app's, or the overlay's. A closed shadow root hides its
 * nodes from composedPath(), so the overlay's own field is found through `shadow.activeElement`.
 */
export const isTyping = (e: Event, shadow?: ShadowRoot | null) => e.composedPath().some(editable) || (!!shadow && editable(shadow.activeElement));

export function matchHotkey(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split('+');
  const key = parts.pop()!;
  const want = { alt: parts.includes('alt'), shift: parts.includes('shift'), ctrl: parts.includes('ctrl'), meta: parts.includes('meta') || parts.includes('cmd') };
  if (e.altKey !== want.alt || e.shiftKey !== want.shift || e.ctrlKey !== want.ctrl || e.metaKey !== want.meta) return false;
  return e.code === (key.length === 1 ? (/[0-9]/.test(key) ? 'Digit' : 'Key') + key.toUpperCase() : key) || e.key.toLowerCase() === key;
}
