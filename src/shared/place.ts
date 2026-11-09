// Where the launcher sits (the `launcherPosition` option): a side or the middle on each axis, and the
// distance from that edge. Pure, so the server-side option types and the unit tests share it.

export type LauncherX = 'left' | 'center' | 'right';
export type LauncherY = 'top' | 'middle' | 'bottom';
/** `'bottom-right'` (default), `'top-left 24'` (24 px from both edges), `'bottom-left 24 80'` (x, then y), or the object form. */
export type LauncherPosition = string | { x?: LauncherX; y?: LauncherY; offsetX?: number; offsetY?: number };
export interface LauncherPlace { x: LauncherX; y: LauncherY; offsetX: number; offsetY: number }

const DEFAULT: LauncherPlace = { x: 'right', y: 'bottom', offsetX: 16, offsetY: 16 };
const X = new Set<string>(['left', 'center', 'right']), Y = new Set<string>(['top', 'middle', 'bottom']);
const px = (v: unknown, d: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? +v : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(2000, Math.round(n))) : d;
};

/** The launcher's place from the option; anything it can't read falls back to the default (bottom right, 16 px). */
export function launcherPlace(v: LauncherPosition | null | undefined): LauncherPlace {
  if (v && typeof v === 'object') {
    return { x: X.has(v.x as string) ? v.x! : DEFAULT.x, y: Y.has(v.y as string) ? v.y! : DEFAULT.y, offsetX: px(v.offsetX, DEFAULT.offsetX), offsetY: px(v.offsetY, DEFAULT.offsetY) };
  }
  if (typeof v !== 'string' || !v.trim()) return { ...DEFAULT };
  const [where, a, b] = v.trim().toLowerCase().split(/\s+/);
  const out = { ...DEFAULT };
  for (const w of where.split('-')) {
    if (X.has(w)) out.x = w as LauncherX;
    else if (Y.has(w)) out.y = w as LauncherY;
  }
  if (a !== undefined) out.offsetX = out.offsetY = px(a, DEFAULT.offsetX);
  if (b !== undefined) out.offsetY = px(b, out.offsetY);
  return out;
}

/** CSS custom properties for the launcher (the stylesheet reads them; a dragged position overrides them inline). */
export function launcherVars(p: LauncherPlace): Record<string, string> {
  const edge = (side: string, n: number) => `max(${n}px, env(safe-area-inset-${side}))`;
  const tx = p.x === 'center' ? '-50%' : '0', ty = p.y === 'middle' ? '-50%' : '0';
  return {
    '--l-left': p.x === 'left' ? edge('left', p.offsetX) : p.x === 'center' ? '50%' : 'auto',
    '--l-right': p.x === 'right' ? edge('right', p.offsetX) : 'auto',
    '--l-top': p.y === 'top' ? edge('top', p.offsetY) : p.y === 'middle' ? '50%' : 'auto',
    '--l-bottom': p.y === 'bottom' ? edge('bottom', p.offsetY) : 'auto',
    '--l-shift': `translate(${tx}, ${ty})`,
  };
}
