import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import redline from '../../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// Own cacheDir: the fixture servers run side by side and would clobber a shared deps cache.
export default defineConfig({ cacheDir: '.vite-cache', plugins: [redline({ root }), sveltekit()] });
