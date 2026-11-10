import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import redline from '../../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// The agent panel (D53) runs a stand-in CLI that reports through OSC 7501 (test/fixtures/agent), as
// Claude Code (app=claude-code), so its menus are read like Claude Code's.
// One shared session to start with (the default is fresh since 0.10); the fresh-session test switches.
// Two CLIs for the picker (D59): the default one ("node fake-agent.mjs"), and "Fake Two" (no menus read).
const fake = fileURLToPath(new URL('../agent/fake-agent.mjs', import.meta.url));
const agent = {
  clis: [{ id: 'fake', command: process.execPath, args: [fake] }, { id: 'fake-two', label: 'Fake Two', command: process.execPath, args: [fake, '--two'], env: { FAKE_APP: 'fake-two' } }],
  env: { FAKE_APP: 'claude-code' }, sessions: 'shared',
};
// Own cacheDir: the fixture servers run side by side and would clobber a shared deps cache.
export default defineConfig({ root, cacheDir: '.vite-cache', plugins: [redline({ root, directEdit: true, extensions: ['redline.ext.js'], agent })] });
