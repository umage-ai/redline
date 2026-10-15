// Pre-publish check: test the packed tarball the way a consumer gets it.
//   npm run test:package
// 1. builds and packs the package (`npm pack`)
// 2. installs the tarball plus Vite/React/SvelteKit/Astro into a fresh folder outside the repo
// 3. writes one app per framework, wired exactly as the README says (no `root` option; each app is its own git repo)
// 4. type-checks the public entry points, runs `npx redline init`
// 5. runs test/package/*.spec.ts against the apps' dev servers (playwright.package.config.ts)
// Set REDLINE_PKG_KEEP=1 to keep the temp folder for poking around.
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const dev = pkg.devDependencies;
// Long canonical path: on Windows os.tmpdir() can be an 8.3 short name, which Vite's fs.allow rejects (403).
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'redline-pkg-')));
const run = (cmd, cwd = tmp) => execSync(cmd, { cwd, stdio: 'inherit' });
const write = (rel, text) => { const f = path.join(tmp, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
const step = msg => console.log(`\n▸ ${msg}`);

try {
  step(`pack → ${tmp}`);
  run('npm run build', repo);
  const tgz = execSync(`npm pack --ignore-scripts --pack-destination "${tmp}"`, { cwd: repo, encoding: 'utf8' }).trim().split('\n').pop();

  step('install the tarball and the frameworks');
  write('package.json', JSON.stringify({
    name: 'redline-package-test', private: true, type: 'module',
    devDependencies: {
      [pkg.name]: `file:./${tgz}`,
      vite: dev.vite, '@vitejs/plugin-react': dev['@vitejs/plugin-react'], react: dev.react, 'react-dom': dev['react-dom'],
      '@sveltejs/kit': dev['@sveltejs/kit'], '@sveltejs/vite-plugin-svelte': dev['@sveltejs/vite-plugin-svelte'], svelte: dev.svelte,
      astro: dev.astro, typescript: dev.typescript, '@types/node': dev['@types/node'],
    },
  }, null, 2));
  run('npm install --no-audit --no-fund --loglevel=error');
  const installed = path.join(tmp, 'node_modules', ...pkg.name.split('/'));
  if (lstatSync(installed).isSymbolicLink()) throw new Error('package was linked, not installed from the tarball');

  step('write the apps');
  const fixtures = path.join(repo, 'test/fixtures');
  const app = (name, files, config) => {
    const dir = path.join(tmp, 'apps', name);
    for (const f of files) cpSync(path.join(fixtures, f.from ?? name, f.path), path.join(dir, f.path), { recursive: true });
    write(`apps/${name}/${config.file}`, config.text);
    execFileSync('git', ['init', '-q'], { cwd: dir });   // Redline's default root is the nearest .git
  };
  // cacheDir: the apps share one node_modules, so the default .vite cache would be shared too (L7).
  app('react', [{ path: 'index.html' }, { path: 'src' }], { file: 'vite.config.mjs', text:
`import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import redline from '${pkg.name}/vite'

export default defineConfig({ cacheDir: '.vite-cache', plugins: [redline(), react()] })
` });
  app('sveltekit', [{ path: 'src' }, { path: 'svelte.config.js' }], { file: 'vite.config.mjs', text:
`import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import redline from '${pkg.name}/vite'

export default defineConfig({ cacheDir: '.vite-cache', plugins: [redline(), sveltekit()] })
` });
  app('astro', [{ path: 'src' }], { file: 'astro.config.mjs', text:
`import { defineConfig } from 'astro/config'
import redline from '${pkg.name}/astro'

export default defineConfig({ integrations: [redline()] })
` });
  app('node', [{ from: 'vanilla', path: 'index.html' }], { file: 'server.mjs', text:
`// A plain node:http dev server using the framework-free entry.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { redlineMiddleware } from '${pkg.name}/server'

const { api, inject } = redlineMiddleware()
const html = readFileSync(new URL('./index.html', import.meta.url))
http.createServer((req, res) => api(req, res, () => inject(req, res, () => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(html)
}))).listen(Number(process.argv[2]))
` });

  step('type-check the public entry points');
  write('check.ts',
`import redline, { type RedlineViteOptions } from '${pkg.name}/vite'
import astro from '${pkg.name}/astro'
import { redlineMiddleware, parsePage, serializePage, createStore } from '${pkg.name}/server'
const o: RedlineViteOptions = { launcher: false, hotkey: 'alt+shift+r', jsxSource: true, dir: '.redline' }
const plugins = redline(o), integration = astro(o), mw = redlineMiddleware({ serverRoot: '.' })
console.log(plugins.length, integration.name, typeof mw.api, typeof parsePage, typeof serializePage, typeof createStore)
`);
  for (const [module, resolution] of [['esnext', 'bundler'], ['nodenext', 'nodenext']]) {
    run(`npx tsc --noEmit --strict --target es2022 --skipLibCheck --module ${module} --moduleResolution ${resolution} --types node check.ts`);
    console.log(`  ✓ tsc ${resolution}`);
  }

  step('npx redline init');
  const initDir = path.join(tmp, 'apps', 'react');
  writeFileSync(path.join(initDir, 'CLAUDE.md'), '# App\n');
  run('npx redline init .', initDir);
  for (const f of ['.agents/skills/redline/SKILL.md', 'AGENTS.md', '.claude/skills/redline/SKILL.md', '.gitignore', 'CLAUDE.md']) if (!existsSync(path.join(initDir, f))) throw new Error(`init did not write ${f}`);
  if (!readFileSync(path.join(initDir, 'CLAUDE.md'), 'utf8').includes('Redline')) throw new Error('init did not add the CLAUDE.md section');

  step('browser tests against the installed package');
  process.env.REDLINE_PKG_DIR = tmp;   // read by playwright.package.config.ts and the spec
  run(`npx playwright test --config "${path.join(repo, 'playwright.package.config.ts')}"`, repo);
} finally {
  if (process.env.REDLINE_PKG_KEEP) console.log(`\nKept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
