// Sketch mode's toolbar (tools, colour palette, undo, done) and its keys; the drawing itself
// is SketchLayer (sketch.ts).

import { bboxOf, COLORS, SketchLayer, type Tool } from './sketch.ts';
import { h, isTyping } from './dom.ts';
import { ICON, type Part } from './context.ts';
import type { StringKey } from './strings.ts';

const TOOL_KEYS: Record<string, Tool> = { '1': 'rect', '2': 'arrow', '3': 'pen', '4': 'text' };

export const sketchPart: Part<'startSketch' | 'endSketch' | 'renderTools' | 'sketchKey'> = ctx => {
  const { state, t } = ctx;
  const colourName = (name: string) => t(`color${name}` as StringKey);
  let tools: HTMLElement | null = null;
  let paletteOpen = false;   // the colour swatch folds out the palette
  const sketch = () => ctx.draft?.sketch;

  function setPalette(open: boolean) { if (paletteOpen !== open) { paletteOpen = open; renderTools(); } }

  function startSketch() {
    const layer = new SketchLayer(ctx.ui, () => renderTools(), ctx.el.bar);
    layer.labelPlaceholder = t('sketchLabel');
    layer.extTools = ctx.ext.sketchTools;   // the live list: tools added later show up too
    const saved = ctx.store.get('sketchColor', COLORS[0].c);
    layer.color = COLORS.some(x => x.c === saved) ? saved : COLORS[0].c;
    layer.el.addEventListener('pointerdown', () => setPalette(false));   // drawing folds it away
    paletteOpen = false;
    ctx.draft = { type: 'sketch', sketch: layer, x: 0, y: 0 };
    tools = h('div', { class: 'tools' });
    ctx.ui.append(tools);
    renderTools();
  }

  function setColor(c: string) {
    const sk = sketch();
    if (!sk) return;
    sk.color = c;
    ctx.store.set('sketchColor', c);   // the next sketch starts with it too
    paletteOpen = false;
    renderTools();
  }

  function colors(sk: SketchLayer) {
    const cur = COLORS.find(x => x.c === sk.color) ?? COLORS[0];
    return h('span', { class: 'colors' },
      h('button', { class: 'sw current', 'aria-haspopup': 'true', 'aria-expanded': String(paletteOpen), style: `--c:${sk.color}`,
        title: t('colourTitle', { name: colourName(cur.name) }), 'aria-label': `${t('colour')}: ${colourName(cur.name)}`, onclick: () => setPalette(!paletteOpen) }),
      paletteOpen && h('span', { class: 'palette', role: 'radiogroup', 'aria-label': t('colour') }, ...COLORS.map(x =>
        h('button', { class: 'sw' + (sk.color === x.c ? ' on' : ''), role: 'radio', 'aria-checked': String(sk.color === x.c),
          title: colourName(x.name), 'aria-label': colourName(x.name), style: `--c:${x.c}`, onclick: () => setColor(x.c) }))));
  }

  // Keep the folded-out palette on screen (on a phone the swatch can sit near an edge).
  function keepPaletteOnScreen(bar: HTMLElement) {
    const pal = bar.querySelector<HTMLElement>('.palette');
    if (!pal) return;
    // From layout sizes, not getBoundingClientRect: the fold-out animation starts scaled down.
    const swatch = pal.parentElement!.getBoundingClientRect(), w = pal.offsetWidth;
    const left = swatch.left + swatch.width / 2 - w / 2;
    const dx = left < 8 ? 8 - left : left + w > innerWidth - 8 ? innerWidth - 8 - (left + w) : 0;
    if (dx) pal.style.marginLeft = `${dx}px`;
  }

  /** Draws the toolbar; takes it away once there is no sketch any more. */
  function renderTools() {
    if (!tools) return;
    const sk = sketch();
    if (!sk) { tools.remove(); tools = null; return; }
    const tool = (tl: Tool, label: string, key: string) =>
      h('button', { class: sk.tool === tl ? 'on' : '', onclick: () => { sk.tool = tl; renderTools(); } }, label, h('kbd', {}, key));
    // The drag handle (D51), like the toolbar's icon.
    const grip = ctx.config.draggable ? [h('div', { class: 'brand grab', title: t('dragBar'), html: ICON })] : [];
    if (sk.tool.startsWith('ext:') && !ctx.ext.sketchTools.some(x => `ext:${x.id}` === sk.tool)) sk.tool = 'rect';   // removed meanwhile
    tools.replaceChildren(
      ...grip,
      tool('rect', t('box'), '1'), tool('arrow', t('arrow'), '2'), tool('pen', t('pen'), '3'), tool('text', t('sketchText'), '4'),
      // Extension tools (v4) on the next number keys.
      ...ctx.ext.sketchTools.slice(0, 5).map((x, i) => tool(`ext:${x.id}`, x.label, String(5 + i))),
      colors(sk),
      h('button', { title: t('undoTitle'), onclick: () => sk.undo(), disabled: !sk.shapes.length }, t('undo')),
      h('button', { onclick: () => sk.clear(), disabled: !sk.shapes.length }, t('clear')),
      h('button', { title: t('cancelTitle'), onclick: () => endSketch(false) }, t('cancel')),
      h('button', { class: 'done', onclick: () => endSketch(true) }, t('done'), h('kbd', {}, '↵')),
    );
    ctx.placeTools();
    keepPaletteOnScreen(tools);
  }

  function endSketch(keep: boolean) {
    const d = ctx.draft;
    tools?.remove(); tools = null;
    if (!d?.sketch) return;
    if (!keep || !d.sketch.shapes.length) {
      if (keep) ctx.toast(t('nothingDrawn'));
      ctx.cancelDraft(); state.mode = 'idle'; ctx.persist(); ctx.renderAll(); return;
    }
    const b = bboxOf(d.sketch.shapes)!;
    d.sketch.el.style.pointerEvents = 'none';
    // anchor: the smallest element under the drawing's centre that contains all of it
    let under = document.elementFromPoint(b[0] + b[2] / 2, b[1] + b[3] / 2);
    const contains = (el: Element) => { const r = el.getBoundingClientRect(); return r.left <= b[0] + 8 && r.top <= b[1] + 8 && r.right >= b[0] + b[2] - 8 && r.bottom >= b[1] + b[3] - 8; };
    while (under && under !== document.body && !contains(under)) under = under.parentElement;
    d.el = under && under !== document.documentElement && under !== document.body ? under : null;
    d.whole = !d.el;
    d.x = b[0] + b[2]; d.y = b[1];
    ctx.renderPop();
    ctx.hideHl();
    ctx.renderBar();
  }

  /** Keys while drawing (no popover open yet): 1–4 tools, C colour, Ctrl+Z, Enter, Esc. */
  function sketchKey(e: KeyboardEvent): boolean {
    const sk = sketch();
    if (state.mode !== 'sketch' || !sk || ctx.el.popLayer.querySelector('.pop')) return false;
    if (isTyping(e, ctx.shadow)) return true;
    const ext = /^[5-9]$/.test(e.key) ? ctx.ext.sketchTools[+e.key - 5] : undefined;
    const tool = TOOL_KEYS[e.key] ?? (ext ? `ext:${ext.id}` as Tool : undefined);
    if (tool) { sk.tool = tool; renderTools(); }
    else if (e.key === 'c' || e.key === 'C') setColor(COLORS[(COLORS.findIndex(x => x.c === sk.color) + (e.shiftKey ? COLORS.length - 1 : 1)) % COLORS.length].c);
    else if (e.key === 'z' && e.ctrlKey) sk.undo();
    else if (e.key === 'Enter') endSketch(true);
    else if (e.key === 'Escape') { if (paletteOpen) setPalette(false); else endSketch(false); }
    else return true;
    e.preventDefault(); e.stopImmediatePropagation();
    return true;
  }

  return { startSketch, endSketch, renderTools, sketchKey };
};
