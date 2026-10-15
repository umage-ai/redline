// Dev-only transform that stamps HTML elements in Vue SFC templates with
// data-redline-src="path:line:col", like jsx-source.ts does for JSX. Vue's runtime only
// knows the component file (type.__file), not the line an element is written on.
// Uses the app's own vue/compiler-sfc (it ships with vue), so no parser of ours to keep in step.

import { createRequire } from 'node:module';
import path from 'node:path';
import MagicString from 'magic-string';
import { HTML_TAGS, SRC_ATTR } from './jsx-source.ts';

interface TemplateNode {
  type: number;                 // 1 = element
  tag?: string;
  tagType?: number;             // 0 = plain element (1 component, 2 slot, 3 template)
  props?: { name: string }[];
  loc: { start: { offset: number; line: number; column: number } };
  children?: TemplateNode[];
}
export type SfcParse = (src: string, opts: { filename: string; sourceMap?: boolean }) =>
  { descriptor: { template: { ast?: TemplateNode; lang?: string; src?: string } | null } };

/** vue/compiler-sfc as the app resolves it (from its root), else as we do; null without Vue. */
export function loadVueParser(root: string): SfcParse | null {
  for (const from of [path.join(root, 'package.json'), import.meta.url]) {
    try { return (createRequire(from)('vue/compiler-sfc') as { parse: SfcParse }).parse; } catch { /* next */ }
  }
  return null;
}

export function stampVue(code: string, file: string, root: string, parse: SfcParse): { code: string; map: string } | null {
  if (!code.includes('<template')) return null;
  let template;
  try { template = parse(code, { filename: file, sourceMap: false }).descriptor.template; } catch { return null; }
  if (!template?.ast || template.src || (template.lang && template.lang !== 'html')) return null;

  const rel = path.relative(root, file).replace(/\\/g, '/');
  const ms = new MagicString(code);
  let touched = false;
  const visit = (n: TemplateNode) => {
    if (n.type === 1 && n.tagType === 0 && n.tag && HTML_TAGS.has(n.tag) && !n.props?.some(p => p.name === SRC_ATTR)) {
      const { offset, line, column } = n.loc.start;
      if (code.startsWith('<' + n.tag, offset)) {
        ms.appendLeft(offset + 1 + n.tag.length, ` ${SRC_ATTR}="${rel}:${line}:${column}"`);
        touched = true;
      }
    }
    n.children?.forEach(visit);
  };
  visit(template.ast);
  if (!touched) return null;
  return { code: ms.toString(), map: ms.generateMap({ hires: true, source: file, includeContent: true }).toString() };
}
