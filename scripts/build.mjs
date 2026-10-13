// Builds dist/: Node entries (vite, astro, server, cli) as ESM with deps external,
// the browser overlay as one self-contained ESM file, and type declarations in dist/types.
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });

const node = {
  entryPoints: { vite: 'src/vite.ts', astro: 'src/astro.ts', server: 'src/server/index.ts', cli: 'src/cli.ts' },
  outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node20',
  packages: 'external', sourcemap: true, logLevel: 'info',
};
const client = {
  entryPoints: { client: 'src/client/index.ts' },
  outdir: 'dist', bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  minify: !watch, sourcemap: 'inline', logLevel: 'info', legalComments: 'none',
};

if (watch) {
  for (const o of [node, client]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(node), esbuild.build(client)]);
  emitTypes();
}

// Declarations for the package exports (dist/types). tsc keeps the `.ts` import specifiers,
// so rewrite them to `.js`, which consumer TypeScript resolves to the sibling `.d.ts`.
function emitTypes() {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []);
  for (const f of walk('dist/types')) {
    writeFileSync(f, readFileSync(f, 'utf8').replace(/(from\s+|import\()(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2'));
  }
}
