// Source writers: apply a text change straight to the file that renders it (D20).
// Opt-in (`directEdit` option). When text mode opens, the overlay inspects the element: if
// its source holds inline markup, it gets a rich editor that keeps those tags. Before offering
// "Apply to file" it does a dry run; if no writer accepts, the edit stays a text note.
// Writers are tried in order; the first that returns a result (not null) decides.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SourceLoc } from '../shared/types.ts';
import { apply, locateAt, locateUnique, spellings, type Located, type Nth, type Token } from './edit.ts';

export interface EditRequest {
  from: string;          // text the page showed
  to: string;            // text the reviewer wants (innerText of the editor)
  html?: string;         // rich edits: the new source content, built from the inspected tokens
  tag: string;           // the edited element's tag, lowercase
  source?: SourceLoc;    // where the element is written (repo-relative), when the framework says
  url: string;           // page URL, for writers that map pages to files
  /** Several elements with this tag and text on the page: which one (static .html has no source location). */
  nth?: Nth;
}

export type EditResult =
  | { ok: true; file: string; line?: number; writer: string; inspect?: Inspection }
  | { ok: false; reason: string; writer?: string };

/** What the rich editor needs: the element's source content as tokens. */
export interface Inspection {
  tokens: Token[];
  braces: boolean;       // `{}` in text must be encoded (JSX, Svelte, Astro, Vue)
  selfClose: boolean;    // write <br /> (JSX) rather than <br>
  /** Characters the source writes as references ("—" → "&mdash;"); new text keeps that spelling. */
  spell: Record<string, string>;
}

export interface WriterContext {
  root: string;          // repo root (notes and source paths are relative to it)
  serverRoot: string;    // the dev server's root (where index.html and public files live)
  dryRun: boolean;       // check only; don't write
  inspect: boolean;      // return the element's source tokens (implies dryRun)
  /** Repo-relative path → absolute, or null if it's outside the root, in node_modules or the notes folder. */
  resolve(file: string): string | null;
}

export interface SourceWriter {
  name: string;
  /** null = not mine, try the next writer. */
  apply(req: EditRequest, ctx: WriterContext): Promise<EditResult | null>;
}

// File types whose markup we can edit, and whether `{` starts an expression in them.
const MARKUP: Record<string, boolean> = { '.astro': true, '.svelte': true, '.jsx': true, '.tsx': true, '.vue': true, '.html': false, '.htm': false };

const SELF_CLOSE = new Set(['.jsx', '.tsx']);

/** Shared tail of the file writers: inspect, dry run or write what was located. */
async function finish(file: string, rel: string, loc: Located, before: string, braces: boolean, req: EditRequest, writer: string, ctx: WriterContext): Promise<EditResult> {
  if (!loc.ok) return { ok: false, reason: loc.reason, writer };
  if (ctx.inspect) return { ok: true, file: rel, line: loc.line, writer, inspect: {
    tokens: loc.analysis.tokens, braces, selfClose: SELF_CLOSE.has(path.extname(rel).toLowerCase()),
    spell: spellings(loc.analysis.tokens.map(t => t.k === 'text' ? t.raw : '').join('')),
  } };
  const plan = apply(before, loc, req, braces);
  if (!plan.ok) return { ok: false, reason: plan.reason, writer };
  if (!ctx.dryRun) {
    if ((await fs.readFile(file, 'utf8')) !== before) return { ok: false, reason: 'the file changed while editing; try again', writer };
    await fs.writeFile(file, plan.content);
  }
  return { ok: true, file: rel, line: plan.line, writer };
}

/** Astro, Svelte, React (JSX stamp) and Vue templates: edits the element at the reported file:line:col. */
export function markupWriter(): SourceWriter {
  return {
    name: 'markup',
    async apply(req, ctx) {
      const src = req.source;
      if (!src?.file || !src.line) return null;
      const ext = path.extname(src.file).toLowerCase();
      if (!(ext in MARKUP)) return null;
      const file = ctx.resolve(src.file);
      if (!file) return { ok: false, reason: `${src.file} is outside the project`, writer: this.name };
      let before: string;
      try { before = await fs.readFile(file, 'utf8'); } catch { return { ok: false, reason: `can't read ${src.file}`, writer: this.name }; }
      const braces = MARKUP[ext];
      return finish(file, src.file, locateAt(before, { tag: req.tag, line: src.line, col: src.col }, req.from, braces), before, braces, req, this.name, ctx);
    },
  };
}

/**
 * Plain .html pages served from disk (no framework metadata): the one element with exactly this
 * text, or the eq.nth one when the file has as many such elements as the page.
 */
export function staticHtmlWriter(): SourceWriter {
  return {
    name: 'static-html',
    async apply(req, ctx) {
      if (req.source?.file) return null;
      let p: string;
      try { p = decodeURIComponent(new URL(req.url).pathname); } catch { return null; }
      const candidates = p.endsWith('/') ? [p + 'index.html'] : /\.html?$/.test(p) ? [p] : [p + '.html', p + '/index.html'];
      for (const c of candidates) {
        const abs = path.join(ctx.serverRoot, c);
        const rel = path.relative(ctx.root, abs).replace(/\\/g, '/');
        const file = ctx.resolve(rel);
        if (!file) continue;
        let before: string;
        try { before = await fs.readFile(file, 'utf8'); } catch { continue; }
        return finish(file, rel, locateUnique(before, req.tag, req.from, false, req.nth), before, false, req, this.name, ctx);
      }
      return null;
    },
  };
}

export const defaultWriters = (): SourceWriter[] => [markupWriter(), staticHtmlWriter()];

export async function runWriters(writers: SourceWriter[], req: EditRequest, ctx: WriterContext): Promise<EditResult> {
  if (!ctx.inspect && req.html === undefined) {
    if (/[\r\n]/.test(req.to)) return { ok: false, reason: 'line breaks need markup; save it as a note instead' };
    if (req.to === req.from) return { ok: false, reason: 'nothing changed' };
  }
  for (const w of writers) {
    const r = await w.apply(req, ctx);
    if (r) return r;
  }
  return { ok: false, reason: req.source?.file ? `no writer handles ${path.extname(req.source.file) || req.source.file}` : 'the page reports no source location for this element' };
}

/** The guard behind WriterContext.resolve. */
export function resolveInside(root: string, notesDir: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  const parts = r.split(/[\\/]/);
  if (parts.includes('node_modules') || parts.includes('.git') || r.replace(/\\/g, '/').startsWith(notesDir.replace(/\/$/, '') + '/')) return null;
  return abs;
}
