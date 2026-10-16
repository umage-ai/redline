// Demo app for Redline: a small fictional dashboard used for the README screenshots
// (`npm run screenshots`). Run it by hand with `npm run demo`, then press Alt+Shift+R.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import redline from '../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  cacheDir: '.vite-cache',
  plugins: [redline({ root, directEdit: true, extensions: ['redline.ext.js'] }), react()],
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
});
