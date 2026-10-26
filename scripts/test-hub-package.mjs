// Pre-publish check for @umage.ai/redline-hub (D44): the packed tarball, installed into a fresh
// folder, starts through its bin, prints the admin key, and serves the UI, the store protocol
// and MCP. No dependencies may sneak in: the hub is one file on Node's own node:sqlite.
//   node scripts/test-hub-package.mjs        (part of npm run test:package)
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const hubDir = path.join(repo, 'hub');
const pkg = JSON.parse(readFileSync(path.join(hubDir, 'package.json'), 'utf8'));
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'redline-hub-pkg-')));
const step = msg => console.log(`\n▸ ${msg}`);
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
let child;

try {
  step(`pack ${pkg.name} → ${tmp}`);
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
  assert(!pkg.dependencies, 'the hub must not have dependencies');
  const tgz = execSync(`npm pack --ignore-scripts --pack-destination "${tmp}"`, { cwd: hubDir, encoding: 'utf8' }).trim().split('\n').pop();
  const files = execSync(`tar -tzf "${tgz}"`, { cwd: tmp, encoding: 'utf8' }).trim().split('\n').sort();
  assert(files.includes('package/dist/cli.js') && files.includes('package/LICENSE') && files.includes('package/README.md'), `tarball misses files: ${files.join(', ')}`);

  step('install the tarball');
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'hub-package-test', private: true, dependencies: { [pkg.name]: `file:./${tgz}` } }));
  execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: tmp, stdio: 'inherit' });

  step('start it through its bin');
  const bin = path.join(tmp, 'node_modules', '.bin', process.platform === 'win32' ? 'redline-hub.cmd' : 'redline-hub');
  child = spawn(bin, ['--port', '0', '--db', 'hub.db'], { cwd: tmp, shell: process.platform === 'win32' });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const end = Date.now() + 15_000;
  while (!/Sign in:\s+\S+#key=\S+/.test(out)) {
    if (Date.now() > end || child.exitCode !== null) throw new Error(`hub did not start:\n${out}\n${err}`);
    await new Promise(r => setTimeout(r, 100));
  }
  const [, url, key] = /Sign in:\s+(\S+)\/#key=(\S+)/.exec(out);
  assert(!/ExperimentalWarning/.test(err), `the SQLite warning leaked:\n${err}`);
  assert(/127\.0\.0\.1/.test(url) && !/listening on/.test(err), 'localhost by default, no warning');

  step(`drive ${url}`);
  assert((await fetch(url + '/')).headers.get('content-type')?.startsWith('text/html'), 'UI page');
  const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'x-redline-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(login.ok && cookie, 'admin login');
  const api = (method, p, body) => fetch(url + '/api' + p, { method, headers: { cookie, 'x-redline-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const project = await api('POST', '/projects', { name: 'Package test' });
  const { token } = await api('POST', `/projects/${project.slug}/tokens`, { person: 'alice@example.com' });
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const created = await (await fetch(`${project.store}/notes`, { method: 'POST', headers: auth, body: JSON.stringify({ note: { type: 'comment', page: '/', url: 'http://localhost:5173/', body: 'From the tarball' } }) })).json();
  assert(created.author === 'alice@example.com', `protocol create: ${JSON.stringify(created)}`);
  const mcp = await (await fetch(project.mcp, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notes', arguments: {} } }) })).json();
  assert(/From the tarball/.test(mcp.result?.content?.[0]?.text ?? ''), `MCP: ${JSON.stringify(mcp)}`);
  console.log('\n✓ redline-hub package OK');
} finally {
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') { try { execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } }
    else child.kill();
  }
  await new Promise(r => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
