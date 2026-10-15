import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import redline from '../../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// Own cacheDir: the fixture servers run side by side and would clobber a shared deps cache
// (symptom: 504 "Outdated Optimize Dep" and a blank page).
export default defineConfig({
  root,
  cacheDir: '.vite-cache',
  plugins: [redline({ root, directEdit: true }), react()],
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
});
