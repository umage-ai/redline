// Next.js (15+, webpack or Turbopack). `next dev` takes no middleware, so withRedline (D48), in
// `next dev` only:
// - starts the /__redline API on a loopback port of its own and rewrites /__redline/* to it,
// - stamps JSX/TSX elements with their source (the Vite plugin's transform, as a webpack loader
//   that Turbopack runs too).
// The overlay script comes from <Redline /> (`@umage.ai/redline/next/script`) in the root layout.
// `next build` and `next start` get the config back untouched.
//
//   import type { NextConfig } from 'next'
//   import { withRedline } from '@umage.ai/redline/next'
//   const nextConfig: NextConfig = { /* your Next config */ }
//   export default withRedline(nextConfig, { directEdit: true })

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientFile } from './vite.ts';
import { createHandler, findRoot, type RedlineOptions } from './server/handler.ts';
import { API_BASE } from './shared/types.ts';

export interface RedlineNextOptions extends RedlineOptions {
  /** Stamp JSX/TSX elements with their source location. Default true. */
  jsxSource?: boolean;
}

// Next's config shapes, as far as this touches them (no dependency on next's types: withRedline is
// generic, so the app's own `NextConfig` type passes through and Next still checks the config).
type Json = Record<string, any>;
type Rewrite = { source: string; destination: string; basePath?: false; locale?: false };
type Rewrites = Rewrite[] | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] };
export type NextConfig = Json;
export type NextConfigFn<C extends object = NextConfig> = (phase: string, ctx: { defaultConfig: NextConfig }) => C | Promise<C>;

const PHASE_DEV = 'phase-development-server';
const loaderFile = fileURLToPath(new URL('./next-loader.cjs', import.meta.url));
const SIDECAR = Symbol.for('umage.redline.next');

/**
 * The API server, once per process: Next reads its config more than once, and keeps a process
 * per dev server. Listens on 127.0.0.1 only; reviewers reach it through Next's rewrite.
 */
function sidecar(options: RedlineNextOptions, root: string, serverRoot: string): Promise<number> {
  const g = globalThis as { [SIDECAR]?: Promise<number> };
  return g[SIDECAR] ??= new Promise<number>((resolve, reject) => {
    const { api, register } = createHandler({ ...options, root, serverRoot, clientFile });
    const server = http.createServer((req, res) => {
      // Through Next's rewrite every caller comes from 127.0.0.1 (Next adds only x-forwarded-host), and
      // `next dev` listens on the network by default: without tokens, MCP answers direct calls only.
      if (req.headers['x-forwarded-host'] !== undefined && req.url?.startsWith(`${API_BASE}/mcp`) && !options.mcpTokens?.length) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer realm="redline"' });
        res.end(JSON.stringify({ error: "MCP through next dev can't tell local callers from remote ones: use `redline mcp`, or set mcpTokens" }));
        return;
      }
      api(req, res, () => { res.statusCode = 404; res.end(); });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const port = (server.address() as AddressInfo).port;
      register(`http://127.0.0.1:${port}`);   // `redline mcp` (D22) calls this server directly
      console.log(`  \x1b[31m✎ redline\x1b[0m  notes → ${options.dir ?? '.redline'}/  (toggle: ${options.hotkey ?? 'alt+shift+r'})`);
      const lan = networkHost(process.argv, process.env);
      if (lan) console.warn(`[redline] next dev listens on ${lan}: anyone who can reach it can write notes and screenshots to ${options.dir ?? '.redline'}/. To keep it on this machine: next dev -H 127.0.0.1`);
      resolve(port);
    });
  });
}

/**
 * The non-loopback host `next dev` listens on, if it does: every interface unless -H/--hostname says
 * otherwise. Only the CLI process sees the flag (its worker gets the host over IPC), so the worker says nothing.
 */
export function networkHost(argv: string[], env: Record<string, string | undefined>): string | null {
  if (env.NEXT_PRIVATE_WORKER || !argv.includes('dev')) return null;
  const i = argv.findIndex(a => a === '-H' || a === '--hostname' || a.startsWith('--hostname='));
  const host = i < 0 ? '' : argv[i].startsWith('--hostname=') ? argv[i].slice(11) : argv[i + 1] ?? '';
  if (/^(localhost|127(\.\d+){3}|::1|\[::1\])$/i.test(host)) return null;
  return host && host !== '0.0.0.0' && host !== '::' ? host : 'every network interface';
}

function nextVersion(dir: string): number[] {
  try { return String(createRequire(path.join(dir, 'package.json'))('next/package.json').version).split('.').map(Number); }
  catch { return [0]; }
}

/** Wraps a Next config (object or function) so `next dev` runs Redline. */
export function withRedline<C extends object = NextConfig>(config: C | NextConfigFn<C> = {} as C, options: RedlineNextOptions = {}): (phase: string, ctx: { defaultConfig: NextConfig }) => Promise<C> {
  return async (phase, ctx) => {
    const app: C = typeof config === 'function' ? await config(phase, ctx) : config;
    if (phase !== PHASE_DEV) return app;
    const base = app as Json;
    const serverRoot = process.cwd();
    const root = options.root ? path.resolve(options.root) : findRoot(serverRoot);
    const { jsxSource, ...rest } = options;
    const port = await sidecar(rest, root, serverRoot);
    const out: NextConfig = { ...base };

    // Ahead of the app's routes and of basePath, where the overlay looks for it.
    const ours: Rewrite = { source: `${API_BASE}/:path*`, destination: `http://127.0.0.1:${port}${API_BASE}/:path*`, basePath: false };
    if (base.i18n) ours.locale = false;
    out.rewrites = async () => {
      const r: Rewrites = (await base.rewrites?.()) ?? [];
      return Array.isArray(r) ? { beforeFiles: [ours], afterFiles: r, fallback: [] } : { ...r, beforeFiles: [ours, ...(r.beforeFiles ?? [])] };
    };

    if (jsxSource !== false) {
      const loader = { loader: loaderFile, options: { root } };
      out.webpack = (cfg: Json, wctx: Json) => {
        const c = typeof base.webpack === 'function' ? base.webpack(cfg, wctx) : cfg;
        c.module.rules.unshift({ test: /\.[jt]sx$/, exclude: /[\\/]node_modules[\\/]/, enforce: 'pre', use: [loader] });
        return c;
      };
      // Turbopack runs webpack loaders on the files a rule matches; the output stays .tsx/.jsx.
      // Next 15.3 moved the rules from experimental.turbo to turbopack.
      const [major, minor] = nextVersion(serverRoot);
      const legacy = major === 15 && minor < 3;
      const turbo: Json = legacy ? { ...base.experimental?.turbo } : { ...base.turbopack };
      const rules: Json = { ...turbo.rules };
      for (const glob of ['*.tsx', '*.jsx']) {
        if (rules[glob]) console.warn(`[redline] turbopack.rules['${glob}'] is set; source locations for ${glob} files are off under Turbopack`);
        else rules[glob] = { loaders: [loader] };
      }
      if (legacy) out.experimental = { ...base.experimental, turbo: { ...turbo, rules } };
      else out.turbopack = { ...turbo, rules };
    }
    return out as C;
  };
}

export default withRedline;
export type { RedlineOptions };
