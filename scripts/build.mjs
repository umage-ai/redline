// Builds dist/: Node entries (vite, astro, angular, next, server, cli) as ESM with deps external,
// the browser overlay as one self-contained ESM file (what the dev server injects) and as
// side-effect-free ESM modules for embedding (dist/overlay, D49), and type declarations in dist/types.
// Also hub/dist/cli.js: @umage.ai/redline-hub as one file with no dependencies (D44), and
// overlay/dist: @umage.ai/redline-overlay, the same overlay modules and their types on their own (D50),
// agent/dist: @umage.ai/redline-agent, the agent panel (D53), and agent-bridge/dist: @umage.ai/agent-bridge,
// the Redline-free core it bundles (D63; unpublished for now).
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
rmSync('hub/dist', { recursive: true, force: true });
rmSync('overlay/dist', { recursive: true, force: true });
rmSync('agent/dist', { recursive: true, force: true });
rmSync('agent-bridge/dist', { recursive: true, force: true });

const node = {
  entryPoints: { vite: 'src/vite.ts', astro: 'src/astro.ts', angular: 'src/angular.ts', server: 'src/server/index.ts', cli: 'src/cli.ts', next: 'src/next.ts', 'next-script': 'src/next-script.ts' },
  outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node20',
  packages: 'external', sourcemap: true, logLevel: 'info',
};
// The webpack/Turbopack loader for Next (D48): CommonJS, dependencies inlined (@babel/parser is ESM-only).
const nextLoader = {
  entryPoints: { 'next-loader': 'src/next-loader.ts' },
  outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  logLevel: 'info', footer: { js: 'module.exports = module.exports.default;' },
};
const client = {
  entryPoints: { client: 'src/client/index.ts' },
  outdir: 'dist', bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  minify: !watch, sourcemap: 'inline', logLevel: 'info', legalComments: 'none',
};
// @umage.ai/redline-agent (agent/, D53): the overlay extension and the terminal page it frames (xterm.js
// inlined, CSS as text), and the server part as one CommonJS file (node-pty stays external, it is native).
const agent = {
  entryPoints: { panel: 'agent/src/panel.ts', terminal: 'agent/src/terminal.ts' },
  outdir: 'agent/dist', bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  minify: !watch, sourcemap: watch ? 'inline' : false, logLevel: 'info', legalComments: 'none', loader: { '.css': 'text' },
};
// @umage.ai/redline/overlay and its building blocks: shared code in chunks, nothing starts on import.
const OVERLAY = ['mount', 'anchor', 'sketch', 'capture', 'shield', 'styles', 'transport', 'strings'];
const overlay = {
  entryPoints: Object.fromEntries(OVERLAY.map(n => [n, `src/client/${n}.ts`])),
  outdir: 'dist/overlay', bundle: true, splitting: true, platform: 'browser', format: 'esm', target: 'es2022',
  chunkNames: 'chunks/[name]-[hash]', sourcemap: true, logLevel: 'info', legalComments: 'none',
};

const agentServer = {
  entryPoints: { index: 'agent/src/index.ts' },
  outdir: 'agent/dist', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  external: ['node-pty', '@lydell/node-pty'], logLevel: 'info',
  define: { 'import.meta.url': 'undefined' },   // the CommonJS build finds its folder through __dirname
};

// @umage.ai/agent-bridge (agent-bridge/, D63): its server half and its CLI emitter as ESM for Node (node-pty
// and @xterm/headless stay dependencies), its browser client as ESM. agent/ bundles it from source instead.
const bridgeNode = {
  entryPoints: { index: 'agent-bridge/src/index.ts', emit: 'agent-bridge/src/emit.ts' },
  outdir: 'agent-bridge/dist', bundle: true, platform: 'node', format: 'esm', target: 'node20',
  packages: 'external', logLevel: 'info',
};
const bridgeClient = {
  entryPoints: { client: 'agent-bridge/src/client.ts' },
  outdir: 'agent-bridge/dist', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'info',
};

const hub = {
  entryPoints: { cli: 'hub/src/cli.ts' },
  outdir: 'hub/dist', bundle: true, platform: 'node', format: 'esm', target: 'node22',
  sourcemap: true, logLevel: 'info',
};

if (watch) {
  for (const o of [node, nextLoader, client, agent, agentServer, bridgeNode, bridgeClient, overlay, hub]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(node), esbuild.build(nextLoader), esbuild.build(client), esbuild.build(agent), esbuild.build(agentServer), esbuild.build(bridgeNode), esbuild.build(bridgeClient), esbuild.build(overlay), esbuild.build(hub)]);
  emitTypes();
  overlayPackage();
}
angularManifest();

// Angular CLI builder (D23): package.json "builders" points here. The schema is
// @angular/build:dev-server's (copied, so `ng serve --port …` flags parse) plus the `redline`
// block; the builder strips `redline` and validates the rest against Angular's own schema.
function angularManifest() {
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/builders.json', JSON.stringify({
    builders: { 'dev-server': { implementation: './angular.js', schema: './angular-schema.json', description: 'Angular dev server with the Redline overlay' } },
  }, null, 2));
  copyFileSync('src/angular-schema.json', 'dist/angular-schema.json');
}

// @umage.ai/redline-overlay (overlay/): the browser modules and the declarations they reach.
function overlayPackage() {
  cpSync('dist/overlay', 'overlay/dist', { recursive: true });
  for (const d of ['client', 'shared']) cpSync(`dist/types/${d}`, `overlay/dist/types/${d}`, { recursive: true });
  mkdirSync('overlay/dist/types/server', { recursive: true });
  copyFileSync('dist/types/server/edit.d.ts', 'overlay/dist/types/server/edit.d.ts');   // the rich-text Token type
}

// Declarations for the package exports (dist/types). tsc keeps the `.ts` import specifiers,
// so rewrite them to `.js`, which consumer TypeScript resolves to the sibling `.d.ts`. The root is the
// repo (agent-hook.ts re-exports the agent bridge's types, D63): src/ lands in dist/types, the bridge's
// types in dist/types/agent-bridge, and imports between them are rewritten to match.
function emitTypes() {
  rmSync('dist/types-raw', { recursive: true, force: true });
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
  cpSync('dist/types-raw/src', 'dist/types', { recursive: true });
  cpSync('dist/types-raw/agent-bridge/src', 'dist/types/agent-bridge', { recursive: true });
  rmSync('dist/types-raw', { recursive: true, force: true });
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []);
  for (const f of walk('dist/types')) {
    const rel = path.relative('dist/types', path.dirname(f)).split(path.sep).join('/');
    // Where the file came from: src/<rel> or agent-bridge/src/<rest>.
    const from = rel === 'agent-bridge' || rel.startsWith('agent-bridge/') ? 'agent-bridge/src' + rel.slice('agent-bridge'.length) : 'src' + (rel ? '/' + rel : '');
    const moved = spec => {
      const target = path.posix.normalize(path.posix.join(from, spec));
      const out = target.startsWith('agent-bridge/src/') ? 'agent-bridge/' + target.slice('agent-bridge/src/'.length) : target.startsWith('src/') ? target.slice(4) : target;
      const r = path.posix.relative(rel || '.', out);
      return r.startsWith('.') ? r : './' + r;
    };
    writeFileSync(f, readFileSync(f, 'utf8').replace(/(from\s+|import\()(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, (_, a, q, spec) => `${a}${q}${moved(spec)}.js${q}`));
  }
}
