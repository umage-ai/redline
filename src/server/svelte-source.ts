// Stamps HTML elements in .svelte components with data-redline-src="path:line:col Component",
// like jsx-source.ts and vue-source.ts. Under `vite dev` Svelte already tells the overlay where an
// element is written (`__svelte_meta`), so this runs only for a build with `buildSource` (D43):
// a deployed review build gets the same file:line context as a dev server, without serving source.
// Uses the app's own svelte/compiler, so the parser always matches the Svelte the app compiles with.

import { createRequire } from 'node:module';
import path from 'node:path';
import MagicString from 'magic-string';
import { HTML_TAGS, SRC_ATTR } from './jsx-source.ts';

type SvelteNode = { type?: string; name?: string; start?: number; attributes?: { type?: string; name?: string }[]; [k: string]: unknown };
export type SvelteParse = (src: string, opts: { filename?: string; modern: true }) => SvelteNode;

/** svelte/compiler as the app resolves it (from its root), else as we do; null without Svelte 5. */
export function loadSvelteParser(root: string): SvelteParse | null {
  for (const from of [path.join(root, 'package.json'), import.meta.url]) {
    try {
      const parse = (createRequire(from)('svelte/compiler') as { parse?: SvelteParse }).parse;
      if (parse) return parse;
    } catch { /* next */ }
  }
  return null;
}

// Script, style and <svelte:head> hold no elements a reviewer can pin.
const SKIP_KEYS = new Set(['instance', 'module', 'css', 'metadata']);
const SKIP_TYPES = new Set(['Script', 'StyleSheet', 'SvelteHead']);

export function stampSvelte(code: string, file: string, root: string, parse: SvelteParse): { code: string; map: string } | null {
  if (!code.includes('<')) return null;
  let ast: SvelteNode;
  try { ast = parse(code, { filename: file, modern: true }); } catch { return null; }

  const rel = path.relative(root, file).replace(/\\/g, '/');
  const component = path.basename(file).replace(/\.svelte$/, '');
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineCol = (offset: number): [number, number] => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return [lo + 1, offset - lineStarts[lo] + 1];
  };

  const ms = new MagicString(code);
  let touched = false;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    const n = node as SvelteNode;
    if (n.type && SKIP_TYPES.has(n.type)) return;
    if (n.type === 'RegularElement' && n.name && HTML_TAGS.has(n.name) && typeof n.start === 'number'
        && code.startsWith('<' + n.name, n.start) && !n.attributes?.some(a => a.name === SRC_ATTR)) {
      const [line, col] = lineCol(n.start);
      ms.appendLeft(n.start + 1 + n.name.length, ` ${SRC_ATTR}="${rel}:${line}:${col} ${component}"`);
      touched = true;
    }
    for (const [k, v] of Object.entries(n)) if (!SKIP_KEYS.has(k) && v && typeof v === 'object') visit(v);
  };
  visit(ast);
  if (!touched) return null;
  return { code: ms.toString(), map: ms.generateMap({ hires: true, source: file, includeContent: true }).toString() };
}
