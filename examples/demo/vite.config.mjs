// Demo app for Redline: a small fictional dashboard used for the README screenshots
// (`npm run screenshots`). Run it by hand with `npm run demo`, then press Alt+Shift+R.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import redline from '../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// REDLINE_AGENT=1 adds the agent toolbar (D53) running your own `claude` (or REDLINE_AGENT=<command>), and
// makes the toolbar draggable (by its icon) for trying things out.
const cmd = process.env.REDLINE_AGENT;
const agent = cmd ? { command: cmd === '1' ? 'claude' : cmd } : undefined;
export default defineConfig({
  root,
  cacheDir: '.vite-cache',
  plugins: [redline({ root, directEdit: true, extensions: ['redline.ext.js'], ...(agent ? { agent, draggable: true } : {}) }), react()],
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
});
