// Browser smoke for the .NET integration (Umage.Redline.AspNetCore) against the Razor Pages/MVC
// and Blazor Web App samples. The overlay is the same dist/client.js the Node integrations serve.
import { test, expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAZOR = 'http://localhost:5210';
const BLAZOR = 'http://localhost:5211';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const notesDir = path.join(repo, '.redline/e2e-dotnet');

type Saved = { id: string; type: string; target?: { source?: { file: string; line?: number; col?: number }; components?: string[]; html?: string }; file?: string };

const ui = (page: Page, sel: string): Locator => page.locator('redline-root').locator(sel);

async function openOverlay(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeVisible();
}

async function mouseAt(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

async function comment(page: Page, target: Locator, text: string): Promise<Saved> {
  if (!(await ui(page, '.bar button.on').filter({ hasText: 'Comment' }).count())) await page.keyboard.press('c');
  await mouseAt(page, target);
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type(text);
  const saved = page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST').then(r => r.json());
  await page.keyboard.press('Control+Enter');
  return saved;
}

const lineOf = async (rel: string, needle: string) =>
  (await fs.readFile(path.join(repo, rel), 'utf8')).split(/\r?\n/).findIndex(l => l.includes(needle)) + 1;

test.beforeAll(async () => { await fs.rm(notesDir, { recursive: true, force: true }); });

test('razor pages: overlay injected, note names the .cshtml line and the layout chain', async ({ page }) => {
  await openOverlay(page, RAZOR);
  expect(await page.locator('script[data-redline-client]').count()).toBe(1);
  const note = await comment(page, page.getByTestId('title'), 'Say hello to the reviewer.');
  const file = 'dotnet/samples/RazorSample/Pages/Index.cshtml';
  expect(note.target?.source).toMatchObject({ file, line: await lineOf(file, 'data-testid="title"') });
  expect(note.target?.components?.slice(0, 2)).toEqual(['Index', '_Layout']);
  expect(note.target?.html).not.toContain('data-redline-src');
  const md = await fs.readFile(path.join(notesDir, 'pages/dotnet-samples-razorsample--index.md'), 'utf8').catch(() => fs.readFile(path.join(notesDir, 'pages/index.md'), 'utf8'));
  expect(md).toContain(`· ${file}:`);
  expect(md).toContain('Say hello to the reviewer.');
});

test('mvc view: note names Views/Home/Index.cshtml', async ({ page }) => {
  await openOverlay(page, RAZOR + '/mvc');
  const note = await comment(page, page.locator('li').filter({ hasText: 'Sketches' }), 'Rename to Drawings.');
  const file = 'dotnet/samples/RazorSample/Views/Home/Index.cshtml';
  expect(note.target?.source).toMatchObject({ file, line: await lineOf(file, '<li>@item</li>') });
});

test('razor: text mode writes static .cshtml text, refuses @ expressions', async ({ page }) => {
  const rel = 'dotnet/samples/RazorSample/Pages/Edit.cshtml';
  const file = path.join(repo, rel);
  const original = await fs.readFile(file, 'utf8');
  try {
    await openOverlay(page, RAZOR + '/Edit');
    const apply = ui(page, '.pop .btn.apply');
    const edit = async (target: Locator, keys: () => Promise<void>) => {
      if (!(await ui(page, '.bar button.on').filter({ hasText: 'Text' }).count())) await page.keyboard.press('t');
      await mouseAt(page, target);
      await expect(ui(page, '.ed')).toBeFocused();
      await keys();
      await page.keyboard.press('Enter');
      await expect(ui(page, '.pop .diff')).toBeVisible();
    };
    await edit(page.getByTestId('edit-dynamic'), async () => { await page.keyboard.press('Control+A'); await page.keyboard.type('Count 4'); });
    await expect(ui(page, '.pop .why')).toContainText(/Razor code/);
    await expect(apply).toBeDisabled();
    await page.keyboard.press('Escape');

    await edit(page.getByTestId('edit-heading'), async () => { await page.keyboard.press('Control+A'); await page.keyboard.type('Edited @ home & saved'); });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect.poll(() => fs.readFile(file, 'utf8')).toContain('<h2 data-testid="edit-heading">Edited @@ home &amp; saved</h2>');
    await expect(ui(page, '.pop')).toHaveCount(0);
    await expect(ui(page, '.bar button.on')).toHaveCount(0);

    await edit(page.getByTestId('edit-rich'), async () => {
      await expect(ui(page, '.ed.rich b')).toHaveText('chips');
      await page.keyboard.press('End');
      await page.keyboard.type(' daily');
    });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect.poll(() => fs.readFile(file, 'utf8')).toContain('<p data-testid="edit-rich">Fish &amp; <b>chips</b> on the menu daily</p>');
  } finally { await fs.writeFile(file, original); }
});

test('dev MCP over HTTP: list_notes from loopback without a token', async ({ request }) => {
  const r = await request.post(RAZOR + '/__redline/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notes', arguments: { status: 'all' } } } });
  expect(r.ok()).toBe(true);
  const text = (await r.json()).result.content[0].text as string;
  expect(text).toContain('Say hello to the reviewer.');
});

test('blazor: SSR page, enhanced navigation, server interactivity and streaming keep the overlay', async ({ page }) => {
  await openOverlay(page, BLAZOR);
  const home = 'dotnet/samples/BlazorSample/BlazorSample/Components/Pages/Home.razor';
  const n1 = await comment(page, page.getByTestId('title'), 'Friendlier greeting.');
  expect(n1.target?.source).toMatchObject({ file: home, line: await lineOf(home, 'data-testid="title"') });
  expect(n1.target?.components?.slice(0, 2)).toEqual(['Home', 'MainLayout']);
  await page.keyboard.press('Escape');   // closes the overlay

  // enhanced navigation patches the DOM (no page load); the overlay stays, the script isn't duplicated
  await page.evaluate(() => { (window as unknown as { __kept: number }).__kept = 1; });
  await page.getByRole('link', { name: 'server counter' }).click();
  await expect(page.getByTestId('server-title')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1);
  await expect(ui(page, '.launcher')).toBeVisible();
  expect(await page.locator('redline-root').count()).toBe(1);
  expect(await page.locator('script[data-redline-client]').count()).toBe(1);

  // interactive server rendering adds stamped markup over SignalR
  await expect(async () => {
    await page.getByTestId('server-click').click();
    await expect(page.getByTestId('server-added')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeVisible();
  const counter = 'dotnet/samples/BlazorSample/BlazorSample/Components/Pages/ServerCounter.razor';
  const n2 = await comment(page, page.getByTestId('server-added'), 'Make this a toast.');
  expect(n2.target?.source).toMatchObject({ file: counter, line: await lineOf(counter, 'data-testid="server-added"') });

  // streaming rendering: the page arrives in parts, the overlay is there
  await page.goto(BLAZOR + '/weather');
  await expect(page.locator('table')).toBeVisible();
  await expect(ui(page, '.launcher')).toBeAttached();
  const td = await page.locator('table td').first().getAttribute('data-redline-src');
  expect(td).toMatch(/Components\/Pages\/Weather\.razor:\d+:\d+$/);
});

test('blazor webassembly: components from the .Client project carry stamps', async ({ page }) => {
  await page.goto(BLAZOR + '/counter', { waitUntil: 'networkidle' });
  const src = await page.getByRole('heading', { name: 'Counter' }).getAttribute('data-redline-src');
  expect(src).toBe(`dotnet/samples/BlazorSample/BlazorSample.Client/Pages/Counter.razor:${await lineOf('dotnet/samples/BlazorSample/BlazorSample.Client/Pages/Counter.razor', '<h1>Counter</h1>')}:1`);
  await expect(async () => {
    await page.getByRole('button', { name: 'Click me' }).click();
    await expect(page.getByRole('status')).toHaveText('Current count: 1', { timeout: 1000 });
  }).toPass();
});
