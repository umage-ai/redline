// The webpack loader withRedline adds in `next dev` (D48), which Turbopack runs too: the Vite
// plugin's JSX stamp (data-redline-src="file:line:col Component") on .jsx/.tsx outside node_modules.
// Built as CommonJS with its dependencies inlined (dist/next-loader.cjs), the form both bundlers load.

import { stampJsx } from './server/jsx-source.ts';

interface LoaderContext {
  resourcePath: string;
  getOptions?(): { root?: string };
  query?: { root?: string } | string;
  callback(err: Error | null, code?: string, map?: unknown): void;
}

export default function redlineLoader(this: LoaderContext, code: string, map?: unknown): void {
  const file = this.resourcePath;
  const opts = this.getOptions?.() ?? (typeof this.query === 'object' ? this.query : {});
  const out = file && !/[\\/]node_modules[\\/]/.test(file) ? stampJsx(code, file, opts.root ?? process.cwd()) : null;
  if (out) this.callback(null, out.code, JSON.parse(out.map));   // SWC (Next) reads only an object
  else this.callback(null, code, map);
}
