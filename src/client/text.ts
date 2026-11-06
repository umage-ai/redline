// Text mode: rewrite an element's text in place. When the source has inline markup (D20), the
// editor shows it and serialising writes every original tag back byte for byte.

import type { Token } from '../server/edit.ts';
import { cmsInfo, sourceInfo } from './anchor.ts';
import { esc, h } from './dom.ts';
import { bgOf, blockText, nthOf } from './page-dom.ts';
import type { Draft, Part } from './context.ts';
import type { Inspection } from './transport.ts';

// The rich editor's content: source tags become plain elements tagged with their token index,
// so serialising can write each one back byte for byte. Tag names are from the server's
// inline allowlist; attributes are left out on purpose (they stay in the source).
export function richHtml(tokens: Token[]): string {
  return tokens.map((t, i) => t.k === 'text' ? esc(t.text)
    : !/^[a-z][a-z0-9]*$/.test(t.tag) ? ''
    : t.k === 'close' ? `</${t.tag}>` : `<${t.tag} data-rl="${i}">`).join('');
}

const ADDABLE = ['b', 'i', 'u', 's', 'em', 'strong'];

/** The editor's content as source: original tags verbatim, unchanged text verbatim, the rest encoded. */
export function serialize(ed: HTMLElement, insp: Inspection): string {
  const texts = insp.tokens.filter(t => t.k === 'text') as Extract<Token, { k: 'text' }>[];
  const rawText = new Map(texts.map(t => [t.text, t.raw]));
  const keepNbsp = texts.some(t => t.text.includes(' '));
  // Characters the source wrote as references (`&mdash;`) are written the same way again.
  const spell: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', ' ': '&nbsp;',
    ...(insp.braces ? { '{': '&#123;', '}': '&#125;' } : {}), ...insp.spell };
  const encode = (s: string) => {
    if (!keepNbsp) s = s.replace(/ /g, ' ');   // Chrome types nbsp at the end of a line
    let out = '';
    for (const ch of s) out += spell[ch] ?? ch;
    return out;
  };
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) { const t = (n as Text).data; return rawText.get(t) ?? encode(t); }
    if (!(n instanceof Element)) return '';
    const kids = Array.from(n.childNodes).map(walk).join('');
    const i = n.getAttribute('data-rl');
    const tok = i === null ? undefined : insp.tokens[+i];
    if (tok && tok.k === 'open' && tok.tag === n.localName) return tok.raw + kids + insp.tokens[tok.close].raw;
    if (tok && tok.k === 'void' && tok.tag === n.localName) return tok.raw;
    if (n.localName === 'br') return insp.selfClose ? '<br />' : '<br>';
    if (ADDABLE.includes(n.localName)) return `<${n.localName}>${kids}</${n.localName}>`;
    return kids;   // whatever else the browser made (div, styled span): keep its text
  };
  const nodes = Array.from(ed.childNodes);
  const last = nodes[nodes.length - 1];
  if (last instanceof HTMLBRElement && !last.hasAttribute('data-rl')) nodes.pop();   // Chrome's placeholder <br>
  return nodes.map(walk).join('');
}

const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'color', 'wordSpacing', 'textIndent'] as const;

/** An editor laid exactly over `block`, in its font and colours. */
function editorOver(block: Element, from: string, rich: Inspection | undefined): HTMLElement {
  const r = block.getBoundingClientRect();
  const cs = getComputedStyle(block);
  const ed = h('div', { class: 'ed' + (rich ? ' rich' : ''), contenteditable: rich ? 'true' : 'plaintext-only', spellcheck: 'true' });
  if (rich) ed.innerHTML = richHtml(rich.tokens); else ed.textContent = from;
  for (const k of COPY) (ed.style as unknown as Record<string, string>)[k] = cs[k];
  Object.assign(ed.style, { left: `${r.x}px`, top: `${r.y}px`, minWidth: `${r.width}px`, maxWidth: `${Math.max(r.width, innerWidth - r.x - 8)}px`, minHeight: `${r.height}px`, background: bgOf(block) });
  ed.style.width = cs.display.startsWith('inline') ? 'auto' : `${r.width}px`;
  return ed;
}

function caretAtEnd(ed: HTMLElement) {
  const sel = getSelection(); const range = document.createRange();
  range.selectNodeContents(ed); range.collapse(false); sel?.removeAllRanges(); sel?.addRange(range);
}

export const textPart: Part<'startTextEdit'> = ctx => {
  // When text mode opens on an element: is it written in source, and with inline markup?
  // Then the editor shows that markup and keeps it (the presentations editor's approach).
  async function inspectBlock(block: Element, from: string): Promise<Inspection | null> {
    const edit = ctx.transport.edit;
    if (!ctx.config.directEdit || !edit) return null;
    const req = edit({ from, tag: block.localName, url: location.href, source: sourceInfo(block).source, nth: nthOf(block, from), cms: cmsInfo(block) }, 'inspect');
    const r = await Promise.race([req.catch(() => null), new Promise<null>(res => setTimeout(() => res(null), 1500))]);
    return r?.ok && r.inspect ? r.inspect : null;
  }

  async function startTextEdit(block: Element) {
    const r = block.getBoundingClientRect();
    const from = blockText(block);
    // Hold the pick while asking the server whether the source has inline markup to keep.
    const pending: Draft = { type: 'text', el: block, x: r.right, y: r.bottom, from };
    ctx.draft = pending;
    ctx.showHl(block, null, 'text');
    const insp = await inspectBlock(block, from);
    if (ctx.draft !== pending) return;
    const rich = insp && insp.tokens.some(t => t.k !== 'text') ? insp : undefined;
    const ed = editorOver(block, from, rich);
    const original = rich ? serialize(ed, rich) : '';
    ctx.el.popLayer.replaceChildren(ed);
    ctx.draft = { ...pending, editor: ed, rich };
    ctx.renderBar();
    ed.focus();
    caretAtEnd(ed);   // where the user clicked would be nicer

    const commit = () => {
      const to = ed.innerText.replace(/\n$/, '').trim();
      const html = rich ? serialize(ed, rich) : undefined;
      if (to === from && html === (rich ? original : undefined)) { ctx.cancelDraft(); return; }
      const d = ctx.draft!;
      d.to = to;
      d.html = html;
      ed.contentEditable = 'false';
      const er = ed.getBoundingClientRect();
      d.x = er.left; d.y = er.bottom;
      ctx.renderPop();
      ctx.el.popLayer.prepend(ed);   // keep the new text showing under the popover
    };
    ed.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); ctx.cancelDraft(); }
    });
    // Rich editor: paste plain text only, so no markup from elsewhere gets in.
    if (rich) ed.addEventListener('paste', e => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    });
    ed.addEventListener('blur', () => setTimeout(() => { if (ctx.draft?.editor === ed && ed.isContentEditable) commit(); }, 120));
  }

  return { startTextEdit };
};
