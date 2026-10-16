import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const bin = (p: string) => `node "${path.join(repo, 'node_modules', p)}"`;

export interface Fixture { name: string; dir: string; url: string; command: string; timeout?: number }

const fixture = (name: string, port: number, command: string, timeout?: number): Fixture =>
  ({ name, dir: path.join(repo, 'test/fixtures', name), url: `http://localhost:${port}`, command, timeout });
const vite = (name: string, port: number) => fixture(name, port, `${bin('vite/bin/vite.js')} --config vite.config.mjs --port ${port} --strictPort`);

// cwd is the fixture folder (SvelteKit and Astro read their config from cwd).
export const FIXTURES = {
  vanilla: fixture('vanilla', 5199, `${bin('vite/bin/vite.js')} --config vite.config.mjs --port 5199 --strictPort`),
  react: fixture('react', 5200, `${bin('vite/bin/vite.js')} --config vite.config.mjs --port 5200 --strictPort`),
  sveltekit: fixture('sveltekit', 5201, `${bin('vite/bin/vite.js')} dev --config vite.config.mjs --port 5201 --strictPort`),
  astro: fixture('astro', 5202, `${bin('astro/bin/astro.mjs')} dev --port 5202`),
  // Own node_modules (Angular needs its own TypeScript): serve.mjs installs them on first run.
  angular: fixture('angular', 5203, 'node serve.mjs --port 5203', 300_000),
  vue: vite('vue', 5204),
  solid: vite('solid', 5205),
  preact: vite('preact', 5206),
} satisfies Record<string, Fixture>;
