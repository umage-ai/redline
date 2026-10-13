import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import redline from '../../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// Own cacheDir: the fixture servers run side by side and would clobber a shared deps cache.
export default defineConfig({ root, cacheDir: '.vite-cache', plugins: [redline({ root })] });
