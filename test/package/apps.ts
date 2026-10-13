// The temp apps written by scripts/test-package.mjs, one per framework, each using the installed tarball.
import path from 'node:path';
import type { Fixture } from '../e2e/fixtures.ts';

const root = process.env.REDLINE_PKG_DIR;
if (!root) throw new Error('REDLINE_PKG_DIR is not set. Run `npm run test:package`, which sets up the apps first.');
const bin = (p: string) => `node "${path.join(root, 'node_modules', p)}"`;

const app = (name: string, port: number, command: string): Fixture =>
  ({ name, dir: path.join(root, 'apps', name), url: `http://localhost:${port}`, command });

export const PACKAGE_APPS = {
  react: app('react', 5299, `${bin('vite/bin/vite.js')} --config vite.config.mjs --port 5299 --strictPort`),
  sveltekit: app('sveltekit', 5300, `${bin('vite/bin/vite.js')} dev --config vite.config.mjs --port 5300 --strictPort`),
  astro: app('astro', 5301, `${bin('astro/bin/astro.mjs')} dev --port 5301`),
  node: app('node', 5302, 'node server.mjs 5302'),
} satisfies Record<string, Fixture>;
