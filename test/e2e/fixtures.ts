import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const bin = (p: string) => `node "${path.join(repo, 'node_modules', p)}"`;

export interface Fixture { name: string; dir: string; url: string; command: string; timeout?: number }

// PW_PORT_OFFSET=1000 moves every fixture (6199…) when other apps hold the usual ports.
const OFFSET = Number(process.env.PW_PORT_OFFSET) || 0;
const fixture = (name: string, at: number, command: (port: number) => string, timeout?: number): Fixture =>
  ({ name, dir: path.join(repo, 'test/fixtures', name), url: `http://localhost:${at + OFFSET}`, command: command(at + OFFSET), timeout });
const vite = (name: string, at: number) => fixture(name, at, port => `${bin('vite/bin/vite.js')} --config vite.config.mjs --port ${port} --strictPort`);

// cwd is the fixture folder (SvelteKit and Astro read their config from cwd).
export const FIXTURES = {
  vanilla: vite('vanilla', 5199),
  react: vite('react', 5200),
  sveltekit: fixture('sveltekit', 5201, port => `${bin('vite/bin/vite.js')} dev --config vite.config.mjs --port ${port} --strictPort`),
  astro: fixture('astro', 5202, port => `${bin('astro/bin/astro.mjs')} dev --port ${port}`),
  // Own node_modules (Angular needs its own TypeScript): serve.mjs installs them on first run.
  angular: fixture('angular', 5203, port => `node serve.mjs --port ${port}`, 300_000),
  vue: vite('vue', 5204),
  solid: vite('solid', 5205),
  preact: vite('preact', 5206),
  // Next.js 15 (D48): one app, served twice (webpack and Turbopack); own node_modules, installed by serve.mjs.
  next: { ...fixture('next', 5207, port => `node serve.mjs ${port}`, 300_000) },
  'next-turbo': { ...fixture('next', 5208, port => `node serve.mjs ${port} --turbopack`, 300_000), name: 'next-turbo' },
  // The voice plugin (D71), with a stand-in transcriber.
  voice: vite('voice', 5209),
} satisfies Record<string, Fixture>;
