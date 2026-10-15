#!/usr/bin/env node
// npm run release -- <patch|minor|major|x.y.z>
//
// Bumps the version on main, commits "Release vX.Y.Z", tags vX.Y.Z and pushes both. The tag push runs
// .github/workflows/publish.yml, which tests everything, publishes to npm (Trusted Publishing) and
// creates the GitHub release with generated notes (D13). Nothing is published from this machine.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const bump = process.argv[2];
// execSync returns null when stdout is inherited (the push), hence the `?? ''`.
const sh = (cmd, opts = {}) => (execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }) ?? '').trim();
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(bump))
  fail('Usage: npm run release -- <patch|minor|major|x.y.z>');

const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') fail(`Releases come from main (you are on ${branch}).`);
if (sh('git status --porcelain --untracked-files=no')) fail('Commit or stash your changes first.');
sh('git fetch origin main --tags --quiet');
if (sh('git rev-parse HEAD') !== sh('git rev-parse origin/main')) fail('main is not in sync with origin/main (pull or push first).');

const from = JSON.parse(readFileSync('package.json', 'utf8')).version;
// npm version: bumps package.json + package-lock.json, commits and tags v<version>.
const tag = sh(`npm version ${bump} -m "Release v%s"`).split('\n').pop();
console.log(`✓ ${from} → ${tag.slice(1)} (commit + tag ${tag})`);

sh(`git push --atomic origin main ${tag}`, { stdio: 'inherit' });
const repo = sh('gh repo view --json nameWithOwner -q .nameWithOwner', { stdio: ['ignore', 'pipe', 'ignore'] }) || 'umage-ai/redline';
console.log(`✓ pushed. The publish workflow is running: https://github.com/${repo}/actions/workflows/publish.yml`);
console.log(`  When it's green: https://www.npmjs.com/package/@umage.ai/redline and https://github.com/${repo}/releases/tag/${tag}`);
