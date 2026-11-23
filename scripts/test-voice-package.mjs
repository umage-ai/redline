// Pre-publish check for @umage.ai/redline-voice (D71): the packed tarball has the server part, the overlay
// extension, the types, README and LICENSE and no dependencies; installed into a fresh folder, `voice()` is a
// plugin whose routes serve the extension and the config, and a voice note goes through (a stand-in engine)
// without the core installed. Behaviour: voice.test.ts, voice.spec.ts.
//   node scripts/test-voice-package.mjs        (part of npm run test:package)
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const dir = path.join(repo, 'voice');
const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'redline-voice-pkg-')));
const step = msg => console.log(`\n▸ ${msg}`);
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
let server;

try {
  step(`pack ${pkg.name} → ${tmp}`);
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
  assert(!pkg.dependencies && !pkg.optionalDependencies, 'no dependencies');
  const tgz = execSync(`npm pack --ignore-scripts --pack-destination "${tmp}"`, { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
  const files = execSync(`tar -tzf "${tgz}"`, { cwd: tmp, encoding: 'utf8' }).trim().split('\n');
  for (const f of ['dist/index.cjs', 'dist/extension.js', 'index.d.ts', 'README.md', 'LICENSE']) assert(files.includes(`package/${f}`), `${f} is not in the tarball`);
  assert(!files.some(f => f.includes('/src/') || f.endsWith('PLAN.md')), 'no sources or plan in the tarball');

  step('install the tarball and run the plugin');
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'voice-package-test', private: true, dependencies: { [pkg.name]: `file:./${tgz}` } }));
  execSync('npm install --omit=peer --no-audit --no-fund --loglevel=error', { cwd: tmp, stdio: 'inherit' });
  const { voice } = createRequire(path.join(tmp, 'package.json'))(pkg.name);
  assert(typeof voice === 'function', 'voice() is exported');
  const plugin = voice({ transcribe: { label: 'stub', transcribe: async () => 'Packed and working.' } });
  assert(plugin.name === 'voice' && typeof plugin.setup === 'function', 'voice() is a plugin');
  const notes = [];
  const root = path.join(tmp, 'app');
  mkdirSync(root);
  const routes = plugin.setup({
    root, dir: '.redline', dirPath: path.join(root, '.redline'), markdown: true, base: '/__redline', app: '', serverRoot: root,
    notes: {
      list: async () => notes, get: async id => notes.find(n => n.id === id) ?? null,
      create: async r => { const n = { ...r.note, reply: '', done: false, at: 'now' }; notes.push(n); return { ...n }; },
      update: async (id, p) => { const n = notes.find(x => x.id === id); if (n) Object.assign(n, p); return n ?? null; },
    },
  });
  assert(routes.extensions?.[0] === '/__redline/p/voice/extension.js', `extension URL: ${routes.extensions}`);
  server = http.createServer((req, res) => routes.handle(req, res, req.url.replace('/__redline/p/voice', '').split('?')[0], { local: true }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/__redline/p/voice`;
  const ext = await fetch(`${base}/extension.js`);
  assert(ext.ok && /javascript/.test(ext.headers.get('content-type')), `extension.js: ${ext.status}`);
  const cfg = await (await fetch(`${base}/config`)).json();
  assert(cfg.engines.join() === 'stub' && cfg.key === 'v', `config: ${JSON.stringify(cfg)}`);
  const note = await (await fetch(`${base}/notes`, { method: 'POST', body: JSON.stringify({
    request: { note: { type: 'comment', page: '/', url: 'http://h/', body: '' } }, audio: { data: Buffer.from('x').toString('base64'), mime: 'audio/webm' }, duration: 1,
  }) })).json();
  assert(note.meta?.voice?.status === 'queued', `note: ${JSON.stringify(note)}`);
  for (let i = 0; i < 50 && notes[0]?.meta?.voice?.status !== 'done'; i++) await new Promise(r => setTimeout(r, 50));
  assert(notes[0].body.startsWith('Packed and working.'), `body: ${notes[0].body}`);
  console.log(`\n✓ redline-voice package OK`);
} finally {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
}
