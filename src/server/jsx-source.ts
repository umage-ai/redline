// Dev-only transform that stamps intrinsic HTML elements in .jsx/.tsx with
// data-redline-src="path:line:col". React 19 dropped _debugSource, so this is how a
// pinned note in a React app learns which file and line rendered the element.
// Only known HTML tags are touched: lowercase JSX is also used by renderers
// like react-three-fiber (<mesh>, <line>, <audio>), where an unknown prop would break.

import path from 'node:path';
import { parse } from '@babel/parser';
import MagicString from 'magic-string';

const HTML_TAGS = new Set((
  'a abbr address article aside b bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del ' +
  'details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr i iframe img input ins ' +
  'kbd label legend li main mark menu meter nav ol optgroup option output p picture pre progress q s samp section select small ' +
  'span strong sub summary sup svg table tbody td textarea tfoot th thead time tr u ul var'
).split(' '));

export const SRC_ATTR = 'data-redline-src';

type AnyNode = { type?: string; start?: number; end?: number; loc?: { start: { line: number; column: number } }; [k: string]: unknown };

export function stampJsx(code: string, file: string, root: string): { code: string; map: string } | null {
  if (!code.includes('<')) return null;
  let ast: AnyNode;
  try {
    ast = parse(code, {
      sourceType: 'module',
      errorRecovery: true,
      plugins: file.endsWith('.tsx') ? ['jsx', 'typescript'] : ['jsx'],
    }) as unknown as AnyNode;
  } catch { return null; }

  const rel = path.relative(root, file).replace(/\\/g, '/');
  const ms = new MagicString(code);
  let touched = false;

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    const n = node as AnyNode;
    if (n.type === 'JSXOpeningElement') {
      const name = n.name as AnyNode;
      const attrs = (n.attributes as AnyNode[]) ?? [];
      if (name?.type === 'JSXIdentifier' && HTML_TAGS.has(name.name as string) && n.loc &&
          !attrs.some(a => (a.name as AnyNode)?.name === SRC_ATTR)) {
        ms.appendLeft(name.end!, ` ${SRC_ATTR}="${rel}:${n.loc.start.line}:${n.loc.start.column + 1}"`);
        touched = true;
      }
    }
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue;
      const v = n[k];
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit((ast as AnyNode).program);
  if (!touched) return null;
  return { code: ms.toString(), map: ms.generateMap({ hires: true, source: file, includeContent: true }).toString() };
}
