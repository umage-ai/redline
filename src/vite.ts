// Vite plugin. Only active for `vite dev` (apply: 'serve'), so nothing reaches a build, except
// the source stamps when `buildSource` asks for them (D43): attributes naming file:line, no overlay.
//
//   import redline from '@umage.ai/redline/vite'
//   export default defineConfig({ plugins: [redline(), react()] })

import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { createHandler, findRoot, type RedlineOptions } from './server/handler.ts';
import { stampJsx } from './server/jsx-source.ts';
import { loadVueParser, stampVue, type SfcParse } from './server/vue-source.ts';
import { loadSvelteParser, stampSvelte, type SvelteParse } from './server/svelte-source.ts';

export interface RedlineViteOptions extends RedlineOptions {
  /** Stamp JSX/TSX elements with their source location (React, Preact, Solid). Default true. */
  jsxSource?: boolean;
  /** Stamp elements in Vue SFC templates with their source location. Default true. */
  vueSource?: boolean;
  /**
   * Stamp elements with their source location in `vite build` too (JSX, Vue and Svelte), for a
   * review build that runs the overlay through `redlineMiddleware` (D43). Adds only
   * `data-redline-src="file:line:col Component"` attributes: file paths and component names reach
   * the page, source code does not. Off by default; keep it out of builds the public is served.
   */
  buildSource?: boolean;
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
  let svelteParse: SvelteParse | null | undefined;
  let building = false;
  const jsx: Plugin = {
    name: 'redline:jsx-source',
    apply: (_cfg, env) => env.command === 'serve' || !!options.buildSource,
    enforce: 'pre',
    configResolved(cfg) {
      building = cfg.command === 'build';
      root ||= options.root ?? findRoot(cfg.root);   // the main plugin, which sets it, is serve-only
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (file.includes('/node_modules/')) return null;
      // Svelte says where an element is written in dev (__svelte_meta); a build needs stamps.
      if (building && file.endsWith('.svelte') && file === id) {
        svelteParse ??= loadSvelteParser(root || process.cwd());
        return svelteParse ? stampSvelte(code, file, root || process.cwd(), svelteParse) : null;
      }
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
