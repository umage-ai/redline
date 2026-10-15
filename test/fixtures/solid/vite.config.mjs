import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import redline from '../../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// Own cacheDir: the fixture servers run side by side and would clobber a shared deps cache.
// redline() before solid(): its JSX stamp runs on the source Solid compiles.
export default defineConfig({
  root,
  cacheDir: '.vite-cache',
  plugins: [redline({ root, directEdit: true }), solid()],
});
