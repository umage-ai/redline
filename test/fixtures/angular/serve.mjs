// Starts the Angular fixture's `ng serve` (port 5203). Angular brings its own TypeScript
// major, so this fixture has its own package.json and node_modules, installed on first run.
// `@umage.ai/redline` is linked from the repo (file:../../..), so it loads the built dist/.
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
if (!existsSync(new URL('./node_modules/@angular/build/package.json', import.meta.url))) {
  execSync('npm install --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });
}
const ng = spawn(process.execPath, ['node_modules/@angular/cli/bin/ng.js', 'serve', ...process.argv.slice(2)], {
  cwd: dir, stdio: 'inherit', env: { ...process.env, NG_CLI_ANALYTICS: 'false' },
});
ng.on('exit', code => process.exit(code ?? 0));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => ng.kill(s));
