// What the agent is asking, read off its screen (D53). The server keeps a headless terminal next to
// the pseudo-terminal, so it knows the screen a viewer would see; when a menu sits at the bottom (a
// permission prompt, Claude Code's stepped questions, a trust dialog), `parsePrompt` turns it into a
// view the agent toolbar can show in a card: the lines above it (with their colours: a diff stays red
// and green), the question, the options with their descriptions, the steps, and the key hint.
// Choosing is done like a person would: move the ❯ cursor with the arrow keys, then Enter.

import headless from '@xterm/headless';   // CommonJS: no named exports under Node's ESM loader
const { Terminal } = headless;
type Terminal = InstanceType<typeof headless.Terminal>;
import type { Line, PromptOption, PromptStep, PromptView, Span } from './types.ts';
export type { Line, PromptOption, PromptStep, PromptView, Span } from './types.ts';


const OPTION = /^(\s*)([❯›▶>]\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/;
const RULE = /^\s*[─━═╌┄-]{12,}\s*$/;
const FRAME = /^\s*[─━═]{40,}\s*$/;   // the prompt's frame: a solid rule (dashed ones separate a diff inside it)
const HINT = /\b(Enter to|Esc to|Tab to|to cancel|to navigate|to confirm|to select)\b/i;
const STEPS = /^\s*←\s+(.*?)\s+→\s*$/;
const INPUT = /^(type something|other|something else)\b/i;

/**
 * The menu at the bottom of a screen, or null. A numbered list needs a ❯ on one of its rows; a list
 * without numbers (a trust dialog) also needs a key hint below it, so the agent's own input line
 * (`❯ your prompt…`, continued on indented lines) never reads as a menu.
 */
export function parsePrompt(screen: Line[]): PromptView | null {
  const L = trimEnd(screen);
  // The key hint is the bottom line of a live menu. One higher up, with output below it, belongs to a
  // menu already answered (a CLI that doesn't erase it): no menu.
  const hintAt = L.length && HINT.test(L[L.length - 1].text) ? L.length - 1 : -1;
  const rows = numbered(L, hintAt >= 0 ? hintAt : L.length) ?? (hintAt >= 0 ? unnumbered(L, hintAt) : null);
  if (!rows) return null;
  const options: PromptOption[] = rows.map(r => ({
    label: r.label, selected: r.selected, ...(r.n !== undefined ? { n: r.n } : {}),
    ...(r.desc.length ? { description: r.desc.join(' ') } : {}), ...(INPUT.test(r.label) ? { input: true as const } : {}),
  }));
  // Above the options: back to the prompt's frame (a long rule), then the steps line and the question.
  const top = rows[0].i;
  let start = Math.max(0, top - 16);
  for (let i = top - 1; i >= Math.max(0, top - 30); i--) if (FRAME.test(L[i].text)) { start = i + 1; break; }
  const above = L.slice(start, top);
  let steps: PromptStep[] | undefined;
  const sAt = above.findIndex(l => STEPS.test(l.text));
  if (sAt >= 0) { steps = parseSteps(above[sAt]); above.splice(0, sAt + 1); }
  while (above.length && !above[above.length - 1].text.trim()) above.pop();
  while (above.length && !above[0].text.trim()) above.shift();
  const q = above.length ? above.pop()!.text.trim() : undefined;
  return {
    lines: above.map(l => (l.spans?.length ? l.spans : [{ t: l.text }])),
    ...(q ? { question: q } : {}),
    options,
    ...(steps ? { steps } : {}),
    ...(hintAt >= 0 ? { hint: L[hintAt].text.trim() } : {}),
  };
}

type Row = { i: number; n?: number; label: string; selected: boolean; desc: string[] };

/** `❯ 1. Yes` / `  2. No` up from `end`: numbers counting 1…n (across rules), indented descriptions under them. */
function numbered(L: Line[], end: number): Row[] | null {
  const rows: Row[] = [];
  let desc: string[] = [];
  for (let i = end - 1; i >= Math.max(0, end - 40); i--) {
    const t = L[i].text;
    if (!t.trim() || RULE.test(t)) continue;
    const m = OPTION.exec(t);
    if (m) {
      const n = Number(m[3]);
      if (rows.length && n !== rows[0].n! - 1) break;
      rows.unshift({ i, n, label: m[4], selected: !!m[2], desc: desc.reverse() });
      desc = [];
      if (n === 1) break;
      continue;
    }
    if (/^\s{3,}\S/.test(t) && desc.length < 4) { desc.push(t.trim()); continue; }
    break;
  }
  return rows.length >= 2 && rows[0].n === 1 && rows.some(r => r.selected) ? rows : null;
}

/** A trust-dialog list: the ❯ row and its neighbours at the same text column, right above the hint. */
function unnumbered(L: Line[], hintAt: number): Row[] | null {
  let c = -1;
  for (let i = hintAt - 1; i >= Math.max(0, hintAt - 12); i--) if (/^\s*[❯›]\s+\S/.test(L[i].text)) { c = i; break; }
  if (c < 0) return null;
  const mark = L[c].text.search(/[❯›]/), col = mark + 1 + L[c].text.slice(mark + 1).search(/\S/);
  const isRow = (i: number) => i === c || (!!L[i].text.trim() && L[i].text.search(/\S/) === col);
  let a = c, b = c;
  while (a > 0 && isRow(a - 1)) a--;
  while (b + 1 < hintAt && isRow(b + 1)) b++;
  if (b === a) return null;
  return L.slice(a, b + 1).map((l, k) => ({ i: a + k, label: (k + a === c ? l.text.slice(col) : l.text).trim(), selected: k + a === c, desc: [] }));
}

/** `←  ☐ Color  ☒ Size  ✔ Submit  →`; the current one is highlighted (inverse or a background). */
function parseSteps(line: Line): PromptStep[] {
  const inner = STEPS.exec(line.text)![1];
  const parts = inner.split(/\s{2,}/).filter(Boolean);
  const lit = (line.spans ?? []).filter(s => s.bg && s.t.trim()).map(s => s.t.trim());
  return parts.map(p => {
    const state = p.startsWith('☒') ? 'done' : p.startsWith('✔') ? 'submit' : 'todo';
    const label = p.replace(/^[☐☒✔✓]\s*/, '');
    return { label, state, current: lit.some(t => t.includes(label)) };
  });
}

function trimEnd(lines: Line[]): Line[] {
  let n = lines.length;
  while (n && !lines[n - 1].text.trim()) n--;
  return lines.slice(0, n);
}

// ---------- the screen ----------

/** A headless copy of the agent's screen. */
export class Screen {
  private term: Terminal;
  constructor(cols: number, rows: number) { this.term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true }); }
  private pending = 0;
  private waiters: (() => void)[] = [];
  /** Parsed asynchronously: `settled()` waits until everything written so far is on the screen. */
  write(d: string) {
    this.pending++;
    this.term.write(d, () => { if (--this.pending === 0) this.waiters.splice(0).forEach(w => w()); });
  }
  settled(): Promise<void> { return this.pending ? new Promise(r => this.waiters.push(r)) : Promise.resolve(); }
  /** Writes not on the screen yet. */
  get busy() { return this.pending > 0; }
  resize(cols: number, rows: number) { try { this.term.resize(cols, rows); } catch { /* bad size */ } }
  reset() { this.term.reset(); }
  dispose() { this.term.dispose(); }

  /** The visible rows, with colour runs. */
  lines(): Line[] {
    const b = this.term.buffer.active, out: Line[] = [];
    const cell = b.getNullCell();
    for (let y = b.baseY; y < b.baseY + this.term.rows; y++) {
      const line = b.getLine(y);
      if (!line) { out.push({ text: '' }); continue; }
      const text = line.translateToString(true);
      const spans: Span[] = [];
      let cur: Span | null = null;
      for (let x = 0; x < text.length && x < line.length; x++) {
        line.getCell(x, cell);
        const ch = cell.getChars() || (cell.getWidth() === 0 ? '' : ' ');
        if (!ch && cell.getWidth() === 0) continue;
        let fg = colour(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor());
        let bg = colour(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor());
        if (cell.isInverse()) [fg, bg] = [bg ?? '#131316', fg ?? '#ececf1'];
        const s: Span = { t: ch, ...(fg ? { fg } : {}), ...(bg ? { bg } : {}), ...(cell.isBold() ? { b: true as const } : {}), ...(cell.isDim() ? { dim: true as const } : {}) };
        if (cur && cur.fg === s.fg && cur.bg === s.bg && cur.b === s.b && cur.dim === s.dim) cur.t += ch;
        else { cur = s; spans.push(s); }
      }
      out.push({ text, spans });
    }
    return out;
  }
  /** The menu on screen now, if any. */
  prompt(): PromptView | null { return parsePrompt(this.lines()); }
}

const ANSI = ['#1c1c21', '#ff5c57', '#5af78e', '#f3f99d', '#57c7ff', '#ff6ac1', '#9aedfe', '#c7c7cf',
  '#686868', '#ff6e67', '#5ffa68', '#fffc67', '#6871ff', '#ff77ff', '#60fdff', '#ffffff'];
function colour(rgb: boolean, palette: boolean, v: number): string | undefined {
  if (rgb) return `#${v.toString(16).padStart(6, '0')}`;
  if (!palette) return undefined;
  if (v < 16) return ANSI[v];
  if (v < 232) { const c = v - 16, k = [0, 95, 135, 175, 215, 255]; return `rgb(${k[Math.floor(c / 36)]},${k[Math.floor(c / 6) % 6]},${k[c % 6]})`; }
  const g = 8 + (v - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
