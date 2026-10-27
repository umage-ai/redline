// @umage.ai/redline-hub end to end (D44): the admin creates a project and a reviewer's token in
// the hub's UI, a dev server (the vanilla fixture, started here) points at it with the two
// environment variables the UI shows, the reviewer files a note through the overlay, it shows
// up in the hub at once, and resolving it there turns the reviewer's pin green.
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { openDb, type Db } from '../../hub/src/db.ts';
import { createHub } from '../../hub/src/server.ts';
import { FIXTURES } from './fixtures.ts';
import { comment, openOverlay, ui } from './helpers.ts';

const PORT = 5209;   // after the fixtures (5199-5208); .NET samples use 5210-5213
let db: Db, dir: string, close: () => Promise<void>, hubUrl: string, key: string;
let vite: ViteDevServer | undefined;

// It used 5207 until the Next fixture took it: Linux CI failed with "Port 5207 is already in use" (L48).
test("the hub test's dev server port is not a fixture's", () => {
  expect(Object.values(FIXTURES).map(f => Number(new URL(f.url).port))).not.toContain(PORT);
});

test.beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-hub-e2e-'));
  db = openDb(path.join(dir, 'hub.db'));
  key = db.adminKey()!;
  const server = await createHub({ db }).listen(0, '127.0.0.1');
  hubUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => { server.closeAllConnections(); return new Promise(r => server.close(() => r())); };
});

test.afterAll(async () => {
  await vite?.close();
  delete process.env.REDLINE_STORE_URL;
  delete process.env.REDLINE_STORE_TOKEN;
  await close();
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a project and a token from the hub UI, a note from the overlay, resolved in the hub, green on the page', async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await (await browser.newContext()).newPage();

  // The link the CLI prints signs the admin in.
  await admin.goto(`${hubUrl}/#key=${key}`);
  await expect(admin.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(admin).toHaveURL(/#\/$/);   // the key left the address bar
  await admin.getByLabel('Project name').fill('Agent console');
  await admin.getByRole('button', { name: 'Create project' }).click();
  await expect(admin.getByRole('heading', { name: 'Agent console' })).toBeVisible();

  await admin.getByLabel('Person or agent').fill('alice@example.com');
  await admin.getByRole('button', { name: 'New token' }).click();
  const env = await admin.locator('.secret').first().textContent();
  const storeUrl = /REDLINE_STORE_URL=(\S+)/.exec(env ?? '')?.[1];
  const token = /REDLINE_STORE_TOKEN=(\S+)/.exec(env ?? '')?.[1];
  expect(storeUrl).toBe(`${hubUrl}/p/agent-console`);
  expect(token).toMatch(/^rht_/);
  await expect(admin.getByRole('cell', { name: 'alice@example.com' })).toBeVisible();

  // The reviewer's dev server, with nothing but the two variables set.
  process.env.REDLINE_STORE_URL = storeUrl;
  process.env.REDLINE_STORE_TOKEN = token;
  const { createServer } = await import('vite');
  const f = FIXTURES.vanilla;
  vite = await createServer({ configFile: path.join(f.dir, 'vite.config.mjs'), cacheDir: path.join(f.dir, '.vite-cache-hub'), server: { port: PORT, strictPort: true }, logLevel: 'error' });
  await vite.listen();
  const app = { ...f, url: `http://localhost:${PORT}` };

  const reviewer = await (await browser.newContext()).newPage();
  await openOverlay(reviewer, app);
  const saved = await comment(reviewer, reviewer.getByTestId('agent-save'), 'Make this the secondary button.');
  expect(saved.author).toBe('alice@example.com');
  await expect(ui(reviewer, '.pin')).toHaveCount(1);
  await expect(ui(reviewer, '.pin.resolved')).toHaveCount(0);

  // It is in the hub at once (the UI listens to the same change feed), with its screenshot.
  await admin.getByRole('link', { name: 'Notes' }).click();
  const card = admin.locator('.note').filter({ hasText: 'Make this the secondary button.' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('alice@example.com');
  await expect(card).toContainText('button');
  await expect(card.locator('img.thumb')).toHaveJSProperty('complete', true);
  expect(await card.locator('img.thumb').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

  await card.getByLabel('Reply').fill('Now secondary, in index.html');
  await card.getByRole('button', { name: 'Resolve' }).click();
  await expect(admin.locator('.note')).toHaveCount(0);   // gone from Open

  // The reviewer's pin turns green with the reply, pushed rather than polled; their overlay reports it seen.
  await expect(ui(reviewer, '.pin.resolved')).toHaveCount(1, { timeout: 5000 });
  await ui(reviewer, '.pin.resolved').hover();
  await expect(ui(reviewer, '.tip')).toContainText('Now secondary, in index.html');
  await admin.getByRole('button', { name: 'Resolved' }).click();
  await expect(admin.locator('.note .pill.ok')).toHaveText('resolved · seen');
});

test('a member token signs in to its own project only; an agent token does not sign in', async ({ page }) => {
  const p = db.createProject('solo', 'Solo', [], Date.now());
  const member = db.createToken(p.id, 'bob@example.com', 'member', Date.now()).token;
  const agent = db.createToken(p.id, 'CI agent', 'agent', Date.now()).token;
  await page.goto(hubUrl);
  await page.getByLabel('Admin key or member token').fill(agent);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Agent tokens are for MCP');
  await page.getByLabel('Admin key or member token').fill(member);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Solo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'People & tokens' })).toHaveCount(0);
  await expect(page.locator('#who')).toContainText('bob@example.com');
});
