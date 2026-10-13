// Vite plugin. Only active for `vite dev` (apply: 'serve'), so nothing reaches a build.
//
//   import redline from '@umage-ai/redline/vite'
//   export default defineConfig({ plugins: [redline(), react()] })

import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { createHandler, findRoot, type RedlineOptions } from './server/handler.ts';
import { stampJsx } from './server/jsx-source.ts';

export interface RedlineViteOptions extends RedlineOptions {
  /** Stamp JSX/TSX elements with their source location (for React). Default true. */
  jsxSource?: boolean;
}

export const clientFile = fileURLToPath(new URL('./client.js', import.meta.url));

export default function redline(options: RedlineViteOptions = {}): Plugin[] {
  if (process.env.VITEST) return [];   // Vitest runs Vite in serve mode too
  let root = '';
  const dir = options.dir ?? '.redline';

  const main: Plugin = {
    name: 'redline',
    apply: 'serve',
    config() {
      return { server: { watch: { ignored: [`**/${dir}/**`] } } };
    },
    configResolved(cfg) {
      root = options.root ?? findRoot(cfg.root);
    },
    configureServer(server) {
      const { api, inject } = createHandler({ ...options, root, serverRoot: server.config.root, clientFile });
      // Added before the framework's own middleware so HTML from SvelteKit/Astro/
      // Vite's index.html all passes through the injector.
      server.middlewares.use(api);
      server.middlewares.use(inject);
      server.config.logger.info(`  \x1b[31m✎ redline\x1b[0m  notes → ${dir}/  (toggle: ${options.hotkey ?? 'alt+shift+r'})`);
    },
  };

  const jsx: Plugin = {
    name: 'redline:jsx-source',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      if (options.jsxSource === false) return null;
      const file = id.split('?')[0];
      if (!/\.[jt]sx$/.test(file) || file.includes('/node_modules/')) return null;
      return stampJsx(code, file, root || process.cwd());
    },
  };

  return [main, jsx];
}

export { redline };
export type { RedlineOptions };
