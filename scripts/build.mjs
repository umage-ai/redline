// Builds dist/: Node entries (vite, astro, angular, server, cli) as ESM with deps external,
// the browser overlay as one self-contained ESM file, and type declarations in dist/types.
// Also hub/dist/cli.js: @umage.ai/redline-hub as one file with no dependencies (D44).
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
rmSync('hub/dist', { recursive: true, force: true });

const node = {
  entryPoints: { vite: 'src/vite.ts', astro: 'src/astro.ts', angular: 'src/angular.ts', server: 'src/server/index.ts', cli: 'src/cli.ts' },
  outdir: 'dist', bundle: true, platform: 'node', format: 'esm', target: 'node20',
  packages: 'external', sourcemap: true, logLevel: 'info',
};
const client = {
  entryPoints: { client: 'src/client/index.ts' },
  outdir: 'dist', bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  minify: !watch, sourcemap: 'inline', logLevel: 'info', legalComments: 'none',
};

const hub = {
  entryPoints: { cli: 'hub/src/cli.ts' },
  outdir: 'hub/dist', bundle: true, platform: 'node', format: 'esm', target: 'node22',
  sourcemap: true, logLevel: 'info',
};

if (watch) {
  for (const o of [node, client, hub]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(node), esbuild.build(client), esbuild.build(hub)]);
  emitTypes();
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
