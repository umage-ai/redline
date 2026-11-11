import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import redline from '../../../dist/vite.js';

const root = fileURLToPath(new URL('.', import.meta.url));
// The agent panel (D53) runs a stand-in CLI that reports through OSC 7501 (test/fixtures/agent), as
// Claude Code (app=claude-code), so its menus are read like Claude Code's.
// One shared session to start with (the default is fresh since 0.10); the fresh-session test switches.
// Two CLIs for the picker (D59): the default one ("Fake Code"), and "Fake Two" (no menus read).
// Fake Code has an adapter like Claude Code's (D62): its menus are read, and the toolbar's settings
// offer two models and two effort levels, passed as flags (the fake prints them on its first line).
const fake = fileURLToPath(new URL('../agent/fake-agent.mjs', import.meta.url));
const fakeCode = {
  id: 'fake', name: 'Fake Code', command: process.execPath, menus: true,
  matches: (command, app, args) => app === 'claude-code' || (!app && command === process.execPath && !!args?.includes(fake) && !args.includes('--two')),
  models: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }],
  efforts: ['low', 'high'],
  start: o => ({ args: [...o.args, ...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : [])] }),
};
const agent = {
  clis: [{ id: 'fake', command: process.execPath, args: [fake] }, { id: 'fake-two', label: 'Fake Two', command: process.execPath, args: [fake, '--two'], env: { FAKE_APP: 'fake-two' } }],
  adapters: [fakeCode], env: { FAKE_APP: 'claude-code' }, sessions: 'shared',
};
// Own cacheDir: the fixture servers run side by side and would clobber a shared deps cache.
export default defineConfig({ root, cacheDir: '.vite-cache', plugins: [redline({ root, directEdit: true, extensions: ['redline.ext.js'], agent })] });
