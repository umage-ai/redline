// Pre-publish check for @umage.ai/redline-overlay (D50): the packed tarball has the modules and
// their declarations and no dependencies, installs into a fresh folder, and a TypeScript consumer
// importing every entry type-checks against it. Behaviour is covered by test/e2e/embed.spec.ts.
//   node scripts/test-overlay-package.mjs        (part of npm run test:package)
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const dir = path.join(repo, 'overlay');
const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'redline-overlay-pkg-')));
const step = msg => console.log(`\n▸ ${msg}`);
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

try {
  step(`pack ${pkg.name} → ${tmp}`);
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
  assert(!pkg.dependencies && !pkg.peerDependencies, 'the overlay package must not have dependencies');
  const tgz = execSync(`npm pack --ignore-scripts --pack-destination "${tmp}"`, { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
  const files = execSync(`tar -tzf "${tgz}"`, { cwd: tmp, encoding: 'utf8' }).trim().split('\n');
  for (const [key, v] of Object.entries(pkg.exports)) {
    for (const f of typeof v === 'string' ? [v] : [v.types, v.default]) assert(files.includes('package/' + f.replace(/^\.\//, '')), `${key}: ${f} is not in the tarball`);
  }
  assert(files.includes('package/LICENSE') && files.includes('package/README.md'), 'LICENSE and README');
  assert(!files.some(f => /\/(server|vite|cli)\.js$/.test(f)), 'no server code in the overlay package');

  step('install the tarball and type-check a consumer');
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'overlay-package-test', private: true, type: 'module', dependencies: { [pkg.name]: `file:./${tgz}` } }));
  execSync('npm install --no-audit --no-fund --loglevel=error', { cwd: tmp, stdio: 'inherit' });
  writeFileSync(path.join(tmp, 'check.ts'), `
import { mount, httpTransport, STRINGS, type MountOptions, type RedlineTransport, type StatusDef, type RedlineApi } from '${pkg.name}';
import { describe, resolve } from '${pkg.name}/anchor';
import { SketchLayer } from '${pkg.name}/sketch';
import { screenshot } from '${pkg.name}/capture';
import { shieldApp } from '${pkg.name}/shield';
import { CSS } from '${pkg.name}/styles';
import { translator } from '${pkg.name}/strings';
const base = httpTransport('/api/review');
const transport: RedlineTransport = { ...base, message: async (id: string, body: string) => ({ id, body }) };
const statuses: StatusDef[] = [{ id: 'open' }, { id: 'fixed', done: true }];
const opts: MountOptions = { transport, shadowMode: 'closed', strings: { comment: 'Kommentar' }, config: { statuses }, gate: async el => { el.textContent = 'Sign in'; } };
const t: string = translator({ saved: 'Gemt → {file}' })('saved', { file: 'x' }) + STRINGS.notes;
export async function go(): Promise<RedlineApi> {
  const h = await mount(opts);
  h.api.addSlot({ id: 'ws', render: el => { el.textContent = t; } });
  h.api.gate(async () => {});
  void [describe, resolve, SketchLayer, screenshot, shieldApp, CSS];
  return h.api;
}
`);
  writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', lib: ['es2022', 'dom', 'dom.iterable'], strict: true, noEmit: true, skipLibCheck: false }, files: ['check.ts'] }));
  execFileSync(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', tmp], { stdio: 'inherit' });
  console.log('\n✓ redline-overlay package OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
