// Vite plugin. Only active for `vite dev` (apply: 'serve'), so nothing reaches a build.
//
//   import redline from '@umage.ai/redline/vite'
//   export default defineConfig({ plugins: [redline(), react()] })

import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { createHandler, findRoot, type RedlineOptions } from './server/handler.ts';
import { stampJsx } from './server/jsx-source.ts';
import { loadVueParser, stampVue, type SfcParse } from './server/vue-source.ts';

export interface RedlineViteOptions extends RedlineOptions {
  /** Stamp JSX/TSX elements with their source location (React, Preact, Solid). Default true. */
  jsxSource?: boolean;
  /** Stamp elements in Vue SFC templates with their source location. Default true. */
  vueSource?: boolean;
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
      const { api, inject, register } = createHandler({ ...options, root, serverRoot: server.config.root, clientFile });
      // For `redline mcp` (D22): the URL is known once the server listens.
      server.httpServer?.once('listening', () => setTimeout(() => { const u = server.resolvedUrls?.local[0]; if (u) register(u.replace(/\/$/, '')); }, 0));
      // Added before the framework's own middleware so HTML from SvelteKit/Astro/
      // Vite's index.html all passes through the injector.
      server.middlewares.use(api);
      server.middlewares.use(inject);
      server.config.logger.info(`  \x1b[31m✎ redline\x1b[0m  notes → ${dir}/  (toggle: ${options.hotkey ?? 'alt+shift+r'})`);
    },
  };

  // Before the framework plugins (enforce: 'pre'), so they compile the stamped source.
  let vueParse: SfcParse | null | undefined;
  const jsx: Plugin = {
    name: 'redline:jsx-source',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (file.includes('/node_modules/')) return null;
      if (/\.[jt]sx$/.test(file)) return options.jsxSource === false ? null : stampJsx(code, file, root || process.cwd());
      // Not plugin-vue's ?vue&type=… sub-requests: only the SFC itself.
      if (file.endsWith('.vue') && file === id && options.vueSource !== false) {
        vueParse ??= loadVueParser(root || process.cwd());
        return vueParse ? stampVue(code, file, root || process.cwd(), vueParse) : null;
      }
      return null;
    },
  };

  return [main, jsx];
}

export { redline };
export type { RedlineOptions };
