// Online mode (D34–D36) in a browser: the Optimizely sample on port 5213 with Redline__Online=true,
// notes in the CMS database (LocalDB), editor roles, personal MCP tokens from the overlay panel.
// Runs with REDLINE_E2E_OPTIMIZELY=1.
import { test, expect, type Page, type Locator } from '@playwright/test';

const SITE = 'http://localhost:5213';
test.skip(!process.env.REDLINE_E2E_OPTIMIZELY, 'set REDLINE_E2E_OPTIMIZELY=1 (needs SQL Server LocalDB)');

const ui = (page: Page, sel: string): Locator => page.locator('redline-root').locator(sel);

test('online: anonymous visitors get nothing; an editor gets the overlay, notes in the database, and an MCP token', async ({ page, request }) => {
  // anonymous
  const anon = await (await request.get(SITE + '/', { headers: { accept: 'text/html' } })).text();
  expect(anon).not.toContain('data-redline-client');
  expect(anon).not.toContain('data-redline-cms');
  expect((await request.get(SITE + '/__redline/config')).status()).toBe(404);
  expect((await request.post(SITE + '/__redline/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status()).toBe(401);

  // an editor
  await page.goto(SITE + '/dev/login');
  await page.goto(SITE + '/', { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  if (!(await ui(page, '.bar').isVisible())) await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeVisible();
  await page.keyboard.press('c');
  const b = (await page.getByTestId('static').boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type('Reviewed on the live site.');
  const saved = page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST').then(r => r.json());
  await page.keyboard.press('Control+Enter');
  const note = await saved;
  expect(note).toMatchObject({ author: 'editor', body: 'Reviewed on the live site.' });
  expect(note.file).toBeUndefined();
  const list = await (await page.request.get(SITE + '/__redline/notes')).json();
  expect(list.root).toBe('database');

  // personal token from the panel extension, then MCP with it
  page.on('dialog', d => d.accept('e2e'));
  await page.keyboard.press('n');
  const section = ui(page, '.panel').getByText('Agent access (MCP)');
  await expect(section).toBeVisible();
  await ui(page, '.panel button').filter({ hasText: 'New token' }).click();
  const config = JSON.parse(await ui(page, '.panel pre').textContent() ?? '{}');
  const auth = config.mcpServers.redline.headers.Authorization as string;
  expect(config.mcpServers.redline).toMatchObject({ type: 'http', url: SITE + '/__redline/mcp' });
  const r = await request.post(SITE + '/__redline/mcp', { headers: { authorization: auth }, data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_notes', arguments: {} } } });
  expect(r.status()).toBe(200);
  expect((await r.json()).result.content[0].text).toContain('Reviewed on the live site.');

  // clean up: the note and the token
  await page.request.delete(`${SITE}/__redline/notes/${note.id}`, { headers: { 'x-redline': '1' } });
  const tokens = await (await page.request.get(SITE + '/__redline/tokens')).json();
  for (const t of tokens.tokens) await page.request.delete(`${SITE}/__redline/tokens/${t.id}`, { headers: { 'x-redline': '1' } });
});
