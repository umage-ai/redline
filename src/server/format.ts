// Markdown <-> notes. The markdown is the single source of truth: the overlay
// writes it through the store, an agent edits it by hand (ticks [x], adds "> "
// replies), and every write re-reads the file first so neither side loses edits.
//
// One note:
//   ### [ ] Comment · `button` “Save draft” · [data-testid="save"] · src/Form.svelte:42
//   <!-- redline {"id":"…", …anchor json…} -->
//
//   The instruction, as typed.
//
//   ![screenshot](../assets/<id>.png)
//
//   > Agent's one-line reply.

import type { Note } from '../shared/types.ts';

const MARKDOWN_OWNED = new Set(['body', 'reply', 'done']);
const ANCHOR_RE = /^<!--\s*redline\s+(\{.*\})\s*-->\s*$/;
const HEAD_RE = /^###\s+\[([ xX])\]/;
const ASSET_RE = /^!\[(screenshot|sketch)\]\(.*\)\s*$/;

export const PAGE_PREAMBLE = `<!--
  Written by the Redline overlay (dev only) for a coding agent. The full guide is the
  redline skill (.agents/skills/redline/SKILL.md, installed by \`npx redline init\`).
  Each note: a "### [ ]" heading naming the element and where it lives in source,
  an anchor comment (JSON: url, selector, xpath, source file:line, component chain,
  CMS content and property, viewport, app folder in a monorepo, …; paths are repo-relative), the instruction, optional screenshot/sketch images, and an optional
  "> " reply. Screenshots mark the target with a red box.
  To close a note: tick it ("### [x]") and add a one-line "> " reply saying what
  changed. To ask back: leave it open and put the question in the reply.
  Never edit or delete the <!-- redline … --> comment; never reorder notes.
-->`;

export function clip(s: string | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

const TYPE_LABEL: Record<Note['type'], string> = { comment: 'Comment', sketch: 'Sketch', text: 'Text change' };

export function headingFor(n: Note): string {
  const parts: string[] = [TYPE_LABEL[n.type] ?? n.type];
  const t = n.target;
  if (n.whole || !t) parts.push('whole page');
  else {
    parts.push(`\`${t.tag ?? 'element'}\`` + (t.text ? ` “${clip(t.text, 50)}”` : ''));
    if (t.testid) parts.push(`[data-testid="${t.testid}"]`);
    else if (t.id) parts.push(`#${t.id}`);
    // Text from CMS content: name the content and property rather than the template line.
    if (t.cms?.property) parts.push(`CMS ${[t.cms.type, t.cms.content].filter(Boolean).join(' ') || 'content'}${t.cms.name ? ` “${clip(t.cms.name, 40)}”` : ''} › ${t.cms.property}`);
    else if (t.source) parts.push(t.source.file + (t.source.line ? `:${t.source.line}` : ''));
    else if (t.components?.length) parts.push(`<${t.components[0]}>`);
  }
  return `### [${n.done ? 'x' : ' '}] ${parts.join(' · ')}`;
}

function anchorJson(n: Note): string {
  const meta: Record<string, unknown> = { id: n.id };
  for (const [k, v] of Object.entries(n)) {
    if (MARKDOWN_OWNED.has(k) || v === undefined || v === '' || v === null) continue;
    meta[k] = v;
  }
  // "--" would end the HTML comment early. U+2028/2029 end a line for ANCHOR_RE's `.`, which
  // dropped the whole note on the next read (L30).
  return JSON.stringify(meta).replace(/--/g, '\\u002d\\u002d').replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));
}

function diffBlock(n: Note): string {
  const lines = (s: string, p: string) => s.split('\n').map(l => p + l).join('\n');
  return '```diff\n' + lines(n.from ?? '', '- ') + '\n' + lines(n.to ?? '', '+ ') + '\n```\n';
}

export function serializeNote(n: Note): string {
  let md = `${headingFor(n)}\n<!-- redline ${anchorJson(n)} -->\n\n`;
  if (n.type === 'text') md += diffBlock(n) + '\n';
  if (n.body.trim()) md += n.body.trim() + '\n\n';
  if (n.screenshot) md += `![screenshot](${n.screenshot})\n\n`;
  if (n.sketch) md += `![sketch](${n.sketch})\n\n`;
  if (n.reply.trim()) md += n.reply.trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
  return md;
}

export function serializePage(page: string, url: string | undefined, notes: Note[]): string {
  const app = notes[0]?.app;
  let md = `# Redline — ${app ? app + ' · ' : ''}${page}\n\n${PAGE_PREAMBLE}\n\n`;
  if (url) md += `Page: ${url}\n\n`;
  for (const n of notes) md += serializeNote(n);
  return md.replace(/\n+$/, '\n');
}

export function parsePage(md: string): Note[] {
  const notes: Note[] = [];
  let cur: Note | null = null;
  let body: string[] = [];
  let reply: string[] = [];
  let inDiff = false;

  const flush = () => {
    if (!cur) return;
    cur.body = body.join('\n').trim();
    cur.reply = reply.join('\n').trim();
    if (cur.id) notes.push(cur);
    cur = null; body = []; reply = [];
  };

  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const head = HEAD_RE.exec(line);
    if (head) {
      flush();
      cur = { done: head[1] !== ' ', body: '', reply: '' } as Note;
      continue;
    }
    if (!cur) continue;                      // preamble
    const anchor = ANCHOR_RE.exec(line);
    if (anchor) {
      try { Object.assign(cur, JSON.parse(anchor[1]), { done: cur.done }); } catch { /* keep going */ }
      continue;
    }
    if (inDiff) { if (line.startsWith('```')) inDiff = false; continue; }
    if (cur.type === 'text' && line.startsWith('```diff')) { inDiff = true; continue; }
    if (ASSET_RE.test(line)) continue;       // regenerated from the anchor
    if (/^>\s?/.test(line)) { reply.push(line.replace(/^>\s?/, '')); continue; }
    body.push(line);
  }
  flush();
  return notes;
}

export function pageSlug(page: string): string {
  const s = page.replace(/^\/+|\/+$/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) return 'index';
  if (s.length <= 80) return s;
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return s.slice(0, 70) + '-' + (h >>> 0).toString(36);
}

/** The page file name: one per URL path, prefixed with the app in a monorepo ("apps-web--settings.md"). */
export function pageFile(page: string, app?: string): string {
  return (app ? pageSlug(app) + '--' : '') + pageSlug(page) + '.md';
}

export function serializeIndex(pages: { page: string; app?: string; file: string; open: number; done: number }[]): string {
  const open = pages.reduce((a, p) => a + p.open, 0);
  let md = `# Redline — UI feedback\n\n<!-- Generated by Redline on every change; do not edit. Notes live in pages/*.md. -->\n\n`;
  md += `**${open} open note${open === 1 ? '' : 's'}** across ${pages.filter(p => p.open).length} page(s).\n\n`;
  if (!pages.length) return md;
  const apps = pages.some(p => p.app);   // monorepo: say which app each page belongs to
  md += apps ? `| App | Page | Open | Done | File |\n|---|---|---:|---:|---|\n` : `| Page | Open | Done | File |\n|---|---:|---:|---|\n`;
  for (const p of [...pages].sort((a, b) => b.open - a.open || (a.app ?? '').localeCompare(b.app ?? '') || a.page.localeCompare(b.page))) {
    const app = apps ? (p.app ? `\`${p.app}\`` : '(root)') + ' | ' : '';
    md += `| ${app}\`${p.page}\` | ${p.open} | ${p.done} | [${p.file}](${p.file}) |\n`;
  }
  return md;
}
