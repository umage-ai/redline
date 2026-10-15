import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import redline from '../../../dist/astro.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// The dev toolbar stays on: it strips data-astro-source-* at runtime, which the tests cover.
export default defineConfig({ integrations: [redline({ root, directEdit: true })] });
