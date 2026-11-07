// Whiteboard layer over the viewport: box, arrow, pen, text. Shapes are kept in
// viewport coordinates; the saved SVG has viewBox = viewport size, and the note
// also records scroll + viewport so the drawing can be placed on the page.

export type Shape = (
  | { t: 'rect' | 'arrow'; x1: number; y1: number; x2: number; y2: number }
  // An extension tool's shape (v4): drawn once by its `svg()` and kept as markup.
  | { t: 'ext'; id: string; x1: number; y1: number; x2: number; y2: number; svg: string }
  | { t: 'pen'; pts: [number, number][] }
  | { t: 'text'; x: number; y: number; s: string }
) & { c?: string };   // colour; default INK

export type Tool = 'rect' | 'arrow' | 'pen' | 'text' | `ext:${string}`;

/** A drag-shaped tool from an extension (RedlineSketchTool, v4). */
export interface ExtTool { id: string; svg(box: { x1: number; y1: number; x2: number; y2: number }, color: string, halo: string): string }

const NS = 'http://www.w3.org/2000/svg';
const INK = '#ff2d55';
/** Sketch colours. Each has a halo that keeps it readable on light and dark pages. */
export const COLORS = [
  { name: 'Red', c: INK, halo: 'rgba(0,0,0,.4)' },
  { name: 'Amber', c: '#ffb020', halo: 'rgba(0,0,0,.45)' },
  { name: 'Blue', c: '#2f80ff', halo: 'rgba(255,255,255,.6)' },
  { name: 'Green', c: '#22c55e', halo: 'rgba(0,0,0,.4)' },
  { name: 'Black', c: '#111111', halo: 'rgba(255,255,255,.75)' },
  { name: 'White', c: '#ffffff', halo: 'rgba(0,0,0,.55)' },
];
const haloOf = (c: string) => COLORS.find(x => x.c === c)?.halo ?? 'rgba(0,0,0,.4)';
const r1 = (n: number) => Math.round(n * 10) / 10;

function arrowPath(x1: number, y1: number, x2: number, y2: number) {
  const a = Math.atan2(y2 - y1, x2 - x1), L = 16, w = 0.45;
  return `M${r1(x1)} ${r1(y1)}L${r1(x2)} ${r1(y2)}M${r1(x2 - L * Math.cos(a - w))} ${r1(y2 - L * Math.sin(a - w))}L${r1(x2)} ${r1(y2)}L${r1(x2 - L * Math.cos(a + w))} ${r1(y2 - L * Math.sin(a + w))}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function shapeSvg(s: Shape): string {
  if (s.t === 'ext') return s.svg;
  const c = s.c ?? INK, halo = haloOf(c);
  if (s.t === 'text')
    return `<text x="${r1(s.x)}" y="${r1(s.y)}" font-family="system-ui,sans-serif" font-size="20" font-weight="600" fill="${c}" stroke="${halo}" stroke-width="4" paint-order="stroke">${esc(s.s)}</text>`;
  let d: string;
  if (s.t === 'rect') {
    const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2);
    d = `M${r1(x)} ${r1(y)}h${r1(Math.abs(s.x2 - s.x1))}v${r1(Math.abs(s.y2 - s.y1))}h${r1(-Math.abs(s.x2 - s.x1))}Z`;
  } else if (s.t === 'pen') d = 'M' + s.pts.map(p => `${r1(p[0])} ${r1(p[1])}`).join('L');
  else d = arrowPath(s.x1, s.y1, s.x2, s.y2);
  return `<path d="${d}" stroke="${halo}" stroke-width="8"/><path d="${d}" stroke="${c}" stroke-width="3"/>`;
}

export function bboxOf(shapes: Shape[]): [number, number, number, number] | null {
  const xs: number[] = [], ys: number[] = [];
  for (const s of shapes) {
    if (s.t === 'pen') s.pts.forEach(p => { xs.push(p[0]); ys.push(p[1]); });
    else if (s.t === 'text') { xs.push(s.x, s.x + s.s.length * 11); ys.push(s.y - 20, s.y + 4); }
    else { xs.push(s.x1, s.x2); ys.push(s.y1, s.y2); }
  }
  if (!xs.length) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

export function sketchFile(shapes: Shape[], w: number, h: number, title: string): string {
  return `<svg xmlns="${NS}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n<title>Redline sketch — ${esc(title)}</title>\n` +
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${shapes.map(shapeSvg).join('')}</g>\n</svg>\n`;
}

/** An extension tool's markup for a shape; a throwing tool draws nothing. */
function drawExt(tool: ExtTool, s: { x1: number; y1: number; x2: number; y2: number; c?: string }): string {
  const c = s.c ?? INK;
  try { return String(tool.svg({ x1: r1(s.x1), y1: r1(s.y1), x2: r1(s.x2), y2: r1(s.y2) }, c, haloOf(c)) ?? ''); }
  catch (err) { console.warn('[redline] sketch tool failed:', err); return ''; }
}

export class SketchLayer {
  readonly el: SVGSVGElement;
  readonly shapes: Shape[] = [];
  tool: Tool = 'rect';
  color = INK;
  /** The text tool's input placeholder (the overlay passes its translation). */
  labelPlaceholder = 'Label…';
  /** Extension tools, chosen as `tool = 'ext:<id>'` (the overlay passes its live list). */
  extTools: ExtTool[] = [];
  private live: Shape | null = null;
  private input: HTMLInputElement | null = null;

  /** `before`: mount the drawing surface under the overlay's toolbars, or it eats their taps (L16). */
  constructor(private root: HTMLElement, private onChange: () => void, before: Node | null = null) {
    this.el = document.createElementNS(NS, 'svg');
    this.el.setAttribute('class', 'rl-sketch');
    this.el.addEventListener('pointerdown', this.down);
    this.el.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    root.insertBefore(this.el, before);
    this.render();
  }

  private down = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || this.live) return;
    e.preventDefault();
    const x = e.clientX, y = e.clientY;
    // On touch, focusing an input only opens the keyboard from pointerup (user activation).
    if (this.tool === 'text') {
      if (e.pointerType === 'mouse') this.textAt(x, y);
      else this.el.addEventListener('pointerup', () => this.textAt(x, y), { once: true });
      return;
    }
    const tool = this.tool, ext = tool.startsWith('ext:') ? this.extTools.find(t => `ext:${t.id}` === tool) : undefined;
    if (tool.startsWith('ext:') && !ext) return;   // its extension removed it
    this.live = tool === 'pen' ? { t: 'pen', pts: [[x, y]], c: this.color }
      : ext ? { t: 'ext', id: ext.id, x1: x, y1: y, x2: x, y2: y, svg: '', c: this.color }
      : { t: tool as 'rect' | 'arrow', x1: x, y1: y, x2: x, y2: y, c: this.color };
    this.el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      const s = this.live!;
      if (s.t === 'pen') s.pts.push([m.clientX, m.clientY]);
      else if (s.t !== 'text') { s.x2 = m.clientX; s.y2 = m.clientY; }
      if (s.t === 'ext' && ext) s.svg = drawExt(ext, s);
      this.render();
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
      const s = this.live!;
      this.live = null;
      const b = bboxOf([s]);
      if (b && Math.max(b[2], b[3]) >= 8) { this.shapes.push(s); this.onChange(); } // ignore slips
      this.render();
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  };

  private textAt(x: number, y: number) {
    this.input?.remove();
    const inp = document.createElement('input');
    inp.className = 'rl-sketch-input';
    const color = this.color;   // the colour when the label was started
    inp.style.borderColor = color;
    inp.style.top = `${y - 16}px`;
    inp.placeholder = this.labelPlaceholder;
    // Removing a focused input fires `blur` synchronously, so Enter/Escape would run this twice.
    let closed = false;
    const close = (keep: boolean) => {
      if (closed) return;
      closed = true;
      if (keep && inp.value.trim()) { this.shapes.push({ t: 'text', x, y: y + 4, s: inp.value.trim(), c: color }); this.onChange(); }
      inp.remove(); this.input = null; this.render();
    };
    const commit = () => close(true);
    inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') close(false);
    });
    inp.addEventListener('blur', commit);
    this.root.appendChild(inp);
    inp.style.left = `${Math.max(4, Math.min(x, innerWidth - inp.offsetWidth - 4))}px`;   // keep it on a narrow screen
    this.input = inp;
    setTimeout(() => inp.focus());
  }

  undo() { this.shapes.pop(); this.render(); this.onChange(); }
  clear() { this.shapes.length = 0; this.render(); this.onChange(); }

  render() {
    const all = this.live ? [...this.shapes, this.live] : this.shapes;
    this.el.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
    this.el.innerHTML = `<g fill="none" stroke-linecap="round" stroke-linejoin="round">${all.map(shapeSvg).join('')}</g>`;
  }

  /** A detached copy for compositing onto a screenshot. */
  snapshot(): SVGSVGElement {
    const doc = new DOMParser().parseFromString(sketchFile(this.shapes, innerWidth, innerHeight, ''), 'image/svg+xml');
    return doc.documentElement as unknown as SVGSVGElement;
  }

  destroy() { this.input?.remove(); this.el.remove(); }
}
