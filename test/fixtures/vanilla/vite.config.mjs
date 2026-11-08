import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import redline from '../../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// The agent panel (D53) runs a stand-in CLI that reports through OSC 7501 (test/fixtures/agent).
const agent = { command: process.execPath, args: [fileURLToPath(new URL('../agent/fake-agent.mjs', import.meta.url))] };
// Own cacheDir: the fixture servers run side by side and would clobber a shared deps cache.
export default defineConfig({ root, cacheDir: '.vite-cache', plugins: [redline({ root, directEdit: true, extensions: ['redline.ext.js'], agent })] });
