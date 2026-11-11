// Demo app for Redline: a small fictional dashboard used for the README screenshots
// (`npm run screenshots`). Run it by hand with `npm run demo`, then press Alt+Shift+R.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import redline from '../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// REDLINE_AGENT=1 adds the agent toolbar (D53) with every agent CLI installed here (Claude Code, OpenCode;
// the ▾ picks one, D59), or REDLINE_AGENT=<command> runs just that one. `npm run screenshots` sets
// REDLINE_AGENT=fake (the tests' stand-in CLI, shown as Claude Code and OpenCode) and REDLINE_DIR (its own notes folder).
const cmd = process.env.REDLINE_AGENT;
const fake = fileURLToPath(new URL('../../test/fixtures/agent/fake-agent.mjs', import.meta.url));
const agent = !cmd ? undefined : cmd === '1' ? true : cmd !== 'fake' ? { command: cmd } : {
  clis: [{ id: 'claude-code', label: 'Claude Code', command: process.execPath, args: [fake], env: { FAKE_APP: 'claude-code' } },
    { id: 'opencode', label: 'OpenCode', command: process.execPath, args: [fake, '--two'] }],
  sessions: 'shared',
};
export default defineConfig({
  root,
  cacheDir: '.vite-cache',
  plugins: [redline({ root, dir: process.env.REDLINE_DIR, directEdit: true, extensions: ['redline.ext.js'], ...(agent ? { agent } : {}) }), react()],
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
});
