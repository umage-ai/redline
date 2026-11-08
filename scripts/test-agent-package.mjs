// Pre-publish check for @umage.ai/redline-agent (D53): the packed tarball has the server part, the
// panel's browser files, the types, README and LICENSE; node-pty is its only (optional) dependency;
// installed into a fresh folder (without optional deps, so no native build), `agent()` sets up the
// routes and serves the panel and /info without the core installed. Behaviour: agent.test.ts, agent.spec.ts.
//   node scripts/test-agent-package.mjs        (part of npm run test:package)
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const dir = path.join(repo, 'agent');
const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'redline-agent-pkg-')));
const step = msg => console.log(`\n▸ ${msg}`);
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
let server;

try {
  step(`pack ${pkg.name} → ${tmp}`);
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
  assert(!pkg.dependencies && Object.keys(pkg.optionalDependencies ?? {}).join() === 'node-pty', 'node-pty must be the only (optional) dependency');
  const tgz = execSync(`npm pack --ignore-scripts --pack-destination "${tmp}"`, { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
  const files = execSync(`tar -tzf "${tgz}"`, { cwd: tmp, encoding: 'utf8' }).trim().split('\n');
  for (const f of ['dist/index.js', 'dist/panel.js', 'dist/terminal.js', 'index.d.ts', 'README.md', 'LICENSE']) assert(files.includes(`package/${f}`), `${f} is not in the tarball`);
  assert(!files.some(f => f.includes('/src/')), 'no sources in the tarball');

  step('install the tarball (no optional deps) and serve the panel');
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'agent-package-test', private: true, dependencies: { [pkg.name]: `file:./${tgz}` } }));
  execSync('npm install --omit=optional --no-audit --no-fund --loglevel=error', { cwd: tmp, stdio: 'inherit' });
  const { agent } = createRequire(path.join(tmp, 'package.json'))(pkg.name);
  assert(typeof agent === 'function', 'agent() is exported');
  const routes = agent({ command: process.execPath }).routes({ root: tmp, base: '/__redline' });
  assert(routes.panel === '/__redline/agent/panel.js', `panel URL: ${routes.panel}`);
  server = http.createServer((req, res) => routes.handle(req, res, req.url.replace('/__redline', '').split('?')[0], true));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/__redline/agent`;
  const panel = await fetch(`${base}/panel.js`);
  assert(panel.ok && /javascript/.test(panel.headers.get('content-type')), `panel.js: ${panel.status}`);
  assert((await fetch(`${base}/terminal.js`)).ok, 'terminal.js');
  const info = await (await fetch(`${base}/info`)).json();
  assert(info.running === false && typeof info.token === 'string' && info.commands.length === 1, `info: ${JSON.stringify(info)}`);
  console.log(`\n✓ redline-agent package OK`);
} finally {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
}
