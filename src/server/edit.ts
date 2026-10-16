// Text edits written straight into markup source (D20). Pure string functions, so the
// guards are unit-tested: an edit only lands when the element's content in source is static
// (text, plus inline markup with static attributes) and its text equals what the reviewer saw
// on the page. Anything else (expressions, block markup, components, text the runtime or a
// translation produced) is refused, and the overlay saves a text note instead.

import { LEGACY, PACKED } from './entities.ts';

export interface Range { start: number; innerStart: number; innerEnd: number }

/* ---------- character references (D24) ---------- */

let named: Map<string, string> | null = null;
let legacy: string[] = [];
/** The full HTML named-reference table, unpacked on first use. Names are case-sensitive. */
function namedRefs(): Map<string, string> {
  if (!named) {
    named = new Map(PACKED.split(';').map(e => {
      const [name, cps] = e.split(',');
      return [name, String.fromCodePoint(...cps.split('.').map(h => parseInt(h, 16)))] as [string, string];
    }));
    legacy = LEGACY.split(' ').sort((a, b) => b.length - a.length);   // longest prefix first
  }
  return named;
}

const codePoint = (cp: number) => (cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '�');
const REF = /&(?:#[xX]([0-9a-fA-F]+);?|#(\d+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g;

/** Decode character references the way a browser does in text content. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  const table = namedRefs();
  return s.replace(REF, (m, hex?: string, dec?: string, name?: string, semi?: string) => {
    if (hex !== undefined) return codePoint(parseInt(hex, 16));
    if (dec !== undefined) return codePoint(parseInt(dec, 10));
    if (semi && table.has(name!)) return table.get(name!)!;
    // Without `;` (or unknown with it), a legacy name at the start still decodes: "&copy2026".
    const l = legacy.find(x => name!.startsWith(x));
    return l ? table.get(l)! + m.slice(1 + l.length) : m;
  });
}

/**
 * How the source spelled characters as references, e.g. "—" → "&mdash;". A plain edit writes
 * the same characters the same way, so a file full of `&mdash;` stays that way.
 */
export function spellings(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g)) {
    const ch = decodeEntities(m[0]);
    // Not ASCII whitespace: a stray `&#32;` must not turn every space into one.
    if (ch !== m[0] && [...ch].length === 1 && !/^[\t\n\f\r ]$/.test(ch) && !(ch in out)) out[ch] = m[0];
  }
  return out;
}

/** Whitespace-insensitive form used to compare source text with rendered text. */
export const norm = (s: string) => s.replace(/[\s ]+/g, ' ').trim();

const lineStart = (src: string, line: number): number => {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const nl = src.indexOf('\n', at);
    if (nl < 0) return -1;
    at = nl + 1;
  }
  return at;
};

/** Start offset of the `<tag` written on `line` (1-based), nearest to `col` (1-based) when given. */
export function findStartTag(src: string, tag: string, line: number, col?: number): number {
  const from = lineStart(src, line);
  if (from < 0) return -1;
  const end = src.indexOf('\n', from);
  const text = src.slice(from, end < 0 ? undefined : end);
  const re = new RegExp(`<${escapeRe(tag)}(?=[\\s/>])`, 'gi');
  let best = -1, dist = Infinity;
  for (let m; (m = re.exec(text));) {
    const d = col ? Math.abs(m.index + 1 - col) : m.index;
    if (d < dist) { best = from + m.index; dist = d; }
  }
  return best;
}

/**
 * The element starting at `start` (`<tag …>`): where its content begins and ends.
 * Attribute values may hold `>` inside quotes or `{…}` expressions. Null for a void or
 * self-closing tag, or when the closing tag can't be found.
 */
export function elementAt(src: string, start: number, tag: string): Range | null {
  let i = start + 1 + tag.length, quote = '', depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || (c === '`' && depth)) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && !depth) break;
  }
  if (i >= src.length || src[i - 1] === '/') return null;
  const innerStart = i + 1;
  const re = new RegExp(`<(/?)${escapeRe(tag)}(?=[\\s/>])`, 'gi');
  re.lastIndex = innerStart;
  let open = 1;
  for (let m; (m = re.exec(src));) {
    if (m[1]) { if (--open === 0) return { start, innerStart, innerEnd: m.index }; }
    else {
      const close = src.indexOf('>', m.index);
      if (close > 0 && src[close - 1] !== '/') open++;
    }
  }
  return null;
}

/* ---------- the element's content: plain text, or text with inline markup ---------- */

/**
 * Source content split into text and tags. Tags are kept byte for byte (`raw`), so a rich
 * edit writes them back exactly as written (JSX `className`, quotes, attribute order).
 */
export type Token =
  | { k: 'text'; raw: string; text: string }
  | { k: 'open'; raw: string; tag: string; close: number }   // close = index of its closing token
  | { k: 'close'; raw: string; tag: string }
  | { k: 'void'; raw: string; tag: string };

/** Inline elements a rich edit may contain; anything else (div, img, components) is refused. */
export const INLINE = new Set(('a abbr b bdi bdo br cite code data del dfn em i ins kbd mark q s samp small span strong ' +
  'sub sup time u var wbr').split(' '));
const VOID = new Set(['br', 'wbr']);
// Vue / Angular attributes that decide whether an inline element shows, or what it holds.
const DIRECTIVE = /\s(v-(if|else|else-if|show|for|html|text)|\*[a-zA-Z]+|\[(innerHTML|innerText|textContent|hidden)\]|\[style\.display\])(?=[\s=/>])/;
/** Tags a reviewer may add while editing (Ctrl+B/I/U, Shift+Enter). */
const ADDABLE = /^<\/?(b|i|u|s|em|strong)>$|^<br\s*\/?>$/i;

// A tag with static attributes only: an attribute value can't hold `{`, so expressions are refused.
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s<>"'{}=/]+(?:\s*=\s*(?:"[^"{}]*"|'[^'{}]*'|[^\s<>"'{}=`]+))?)*)\s*(\/?)>/y;

export type Tokens = { ok: true; tokens: Token[] } | { ok: false; reason: string };

/** `braces`: `{` starts an expression (JSX, Svelte, Astro, Vue's `{{`); not in plain HTML. */
export function tokenize(inner: string, braces: boolean): Tokens {
  const tokens: Token[] = [];
  const stack: number[] = [];
  const fail = (reason: string): Tokens => ({ ok: false, reason });
  let i = 0;
  while (i < inner.length) {
    const lt = inner.indexOf('<', i);
    const textEnd = lt < 0 ? inner.length : lt;
    if (textEnd > i) {
      const raw = inner.slice(i, textEnd);
      if (braces && /[{}]/.test(raw)) return fail('the text is rendered from an expression ({…}), not written in source');
      tokens.push({ k: 'text', raw, text: decodeEntities(raw) });
    }
    if (lt < 0) break;
    if (inner.startsWith('<!--', lt)) return fail('the element holds a comment in source');
    TAG.lastIndex = lt;
    const m = TAG.exec(inner);
    if (!m) return fail(braces && /^<[^>]*\{/.test(inner.slice(lt)) ? 'an attribute inside is an expression ({…})' : 'the element holds markup that can\'t be edited inline');
    const [raw, slash, name, , self] = m;
    if (braces && /^[A-Z]/.test(name)) return fail(`the element holds a component (<${name}>)`);
    if (braces && DIRECTIVE.test(raw)) return fail('inline markup is shown or filled by a directive (v-if, *ngIf, [innerHTML], …)');
    const tag = name.toLowerCase();
    if (!INLINE.has(tag)) return fail(`the element holds a <${tag}>; only inline markup can be edited in place`);
    if (slash) {
      const open = stack.pop();
      if (open === undefined || (tokens[open] as { tag: string }).tag !== tag) return fail(`unbalanced </${tag}> in source`);
      (tokens[open] as { close: number }).close = tokens.length;
      tokens.push({ k: 'close', raw, tag });
    } else if (self || VOID.has(tag)) tokens.push({ k: 'void', raw, tag });
    else { stack.push(tokens.length); tokens.push({ k: 'open', raw, tag, close: -1 }); }
    i = lt + raw.length;
  }
  if (stack.length) return fail(`unclosed <${(tokens[stack[0]] as { tag: string }).tag}> in source`);
  return { ok: true, tokens };
}

/** What the page shows for these tokens (innerText-like: tags dropped, <br> as a space). */
export const textOf = (tokens: Token[]) => tokens.map(t => t.k === 'text' ? t.text : t.k === 'void' && t.tag === 'br' ? ' ' : '').join('');

export type Analysis = { ok: true; tokens: Token[]; rich: boolean } | { ok: false; reason: string };

/** Is the source content static (text and inline markup) and equal to `from`, what the page showed? */
export function analyze(inner: string, from: string, braces: boolean): Analysis {
  const t = tokenize(inner, braces);
  if (!t.ok) return t;
  if (norm(textOf(t.tokens)) !== norm(from)) return { ok: false, reason: 'the source text differs from the page (rendered, translated or changed since)' };
  return { ok: true, tokens: t.tokens, rich: t.tokens.some(x => x.k !== 'text') };
}

/** Kept for callers that only need yes/no on plain text. */
export function checkInner(inner: string, from: string, braces: boolean): { ok: true } | { ok: false; reason: string } {
  const a = analyze(inner, from, braces);
  if (!a.ok) return a;
  return a.rich ? { ok: false, reason: 'the element holds markup in source, not just text' } : { ok: true };
}

/**
 * `to` as source text: escaped, the original's surrounding whitespace kept, and characters the
 * original wrote as references (`&mdash;`, `&#8594;`) written the same way again.
 */
export function encodeInner(original: string, to: string, braces: boolean): string {
  const lead = /^\s*/.exec(original)![0], trail = /\s*$/.exec(original)![0];
  return lead + encodeText(to, braces, spellings(original)) + (original.trim() ? trail : '');
}

const MUST: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export function encodeText(s: string, braces: boolean, spell: Record<string, string> = {}): string {
  let out = '';
  for (const ch of s) {
    out += spell[ch] ?? MUST[ch] ?? (braces && ch === '{' ? '&#123;' : braces && ch === '}' ? '&#125;' : ch);
  }
  return out;
}

/**
 * New content from the rich editor: its tags must be the original ones (byte for byte) or
 * simple additions (<b>, <i>, <br>…), balanced, and its text must match `to`.
 */
export function validateHtml(html: string, original: Token[], to: string, braces: boolean): { ok: true } | { ok: false; reason: string } {
  const t = tokenize(html, braces);
  if (!t.ok) return { ok: false, reason: `the edited markup is invalid: ${t.reason}` };
  const known = new Set(original.filter(x => x.k !== 'text').map(x => x.raw));
  const odd = t.tokens.find(x => x.k !== 'text' && !known.has(x.raw) && !ADDABLE.test(x.raw));
  if (odd) return { ok: false, reason: `the edit adds markup that wasn't there (${odd.raw})` };
  if (norm(textOf(t.tokens)) !== norm(to)) return { ok: false, reason: 'the edited markup and text disagree' };
  return { ok: true };
}

/* ---------- locate, then apply ---------- */

export interface Edit { from: string; to: string; html?: string }
export type Located = { ok: true; range: Range; analysis: Extract<Analysis, { ok: true }>; line: number } | { ok: false; reason: string };
export type Planned = { ok: true; content: string; line: number } | { ok: false; reason: string };

const lineOf = (src: string, at: number) => src.slice(0, at).split('\n').length;

/** The element written at line:col, if its content is static and matches `from`. */
export function locateAt(src: string, at: { tag: string; line: number; col?: number }, from: string, braces: boolean): Located {
  const start = findStartTag(src, at.tag, at.line, at.col);
  if (start < 0) return { ok: false, reason: `no <${at.tag}> on line ${at.line} of the source file` };
  const range = elementAt(src, start, at.tag);
  if (!range) return { ok: false, reason: `couldn't find where <${at.tag}> ends in source` };
  const analysis = analyze(src.slice(range.innerStart, range.innerEnd), from, braces);
  return analysis.ok ? { ok: true, range, analysis, line: lineOf(src, start) } : analysis;
}

/**
 * Which of several same-tag, same-text elements was edited: its position among them in
 * document order on the page (`index`, 0-based), and how many the page has (`count`).
 */
export interface Nth { index: number; count: number }

/**
 * The `<tag>` in the file whose content matches `from` (static HTML, no source location).
 * Several matches: `nth` picks one, but only when the file has exactly as many as the page
 * (otherwise one of them is rendered or hidden differently, and the index can't be trusted).
 */
export function locateUnique(src: string, tag: string, from: string, braces = false, nth?: Nth): Located {
  const re = new RegExp(`<${escapeRe(tag)}(?=[\\s/>])`, 'gi');
  const hits: Located[] = [];
  for (let m; (m = re.exec(src));) {
    const range = elementAt(src, m.index, tag);
    if (!range) continue;
    const analysis = analyze(src.slice(range.innerStart, range.innerEnd), from, braces);
    if (analysis.ok) hits.push({ ok: true, range, analysis, line: lineOf(src, m.index) });
  }
  if (!hits.length) return { ok: false, reason: `no <${tag}> with exactly this text in the file (rendered by script?)` };
  if (hits.length === 1) return hits[0];
  if (nth && nth.count === hits.length && nth.index >= 0 && nth.index < hits.length) return hits[nth.index];
  const page = nth ? ` (the page shows ${nth.count})` : '';
  return { ok: false, reason: `${hits.length} <${tag}> elements have this text in the file${page}; can't tell which one` };
}

/** Replace the located element's content: `html` from the rich editor, else plain `to`. */
export function apply(src: string, loc: Extract<Located, { ok: true }>, edit: Edit, braces: boolean): Planned {
  const { range, analysis } = loc;
  const inner = src.slice(range.innerStart, range.innerEnd);
  let next: string;
  if (edit.html !== undefined) {
    const v = validateHtml(edit.html, analysis.tokens, edit.to, braces);
    if (!v.ok) return v;
    next = edit.html;
  } else {
    if (analysis.rich) return { ok: false, reason: 'the element holds markup; edit it in place so the markup is kept' };
    next = encodeInner(inner, edit.to, braces);
  }
  return { ok: true, content: src.slice(0, range.innerStart) + next + src.slice(range.innerEnd), line: loc.line };
}

export function editAt(src: string, at: { tag: string; line: number; col?: number }, edit: Edit, braces: boolean): Planned {
  const loc = locateAt(src, at, edit.from, braces);
  return loc.ok ? apply(src, loc, edit, braces) : loc;
}

export function editUnique(src: string, tag: string, edit: Edit, braces = false, nth?: Nth): Planned {
  const loc = locateUnique(src, tag, edit.from, braces, nth);
  return loc.ok ? apply(src, loc, edit, braces) : loc;
}


function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
