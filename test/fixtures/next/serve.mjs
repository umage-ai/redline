// Starts the Next.js fixture's `next dev`: `node serve.mjs 5207` (webpack) or
// `node serve.mjs 5208 --turbopack`. Next is large, so this fixture has its own package.json
// and node_modules, installed on first run. `@umage.ai/redline` is linked from the repo
// (file:../../..), so it loads the built dist/. Each server gets its own distDir.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const installed = () => existsSync(new URL('./node_modules/next/package.json', import.meta.url));
// Playwright starts both servers at once: the first to create the lock folder installs, the other waits.
const lock = fileURLToPath(new URL('./.install-lock', import.meta.url));
if (!installed()) {
  let mine = true;
  try { mkdirSync(lock); } catch { mine = false; }
  if (mine) {
    try { execSync('npm install --no-audit --no-fund', { cwd: dir, stdio: 'inherit' }); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  }
  while (!installed() && existsSync(lock)) await sleep(1000);
}
const [port, ...flags] = process.argv.slice(2);
const next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', port, ...flags], {
  cwd: dir, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: `.next-${port}` },
});
next.on('exit', code => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => next.kill(s));
