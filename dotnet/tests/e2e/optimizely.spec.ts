// Browser smoke for Umage.Redline.Optimizely against samples/OptimizelySample (CMS 12, LocalDB,
// port 5212). Runs when REDLINE_E2E_OPTIMIZELY=1 (it needs SQL Server LocalDB).
import { test, expect, type Page, type Locator } from '@playwright/test';

const OPTI = 'http://localhost:5212';
test.skip(!process.env.REDLINE_E2E_OPTIMIZELY, 'set REDLINE_E2E_OPTIMIZELY=1 (needs SQL Server LocalDB)');

type Cms = { content?: string; property?: string; name?: string; type?: string; lang?: string; edit?: string };
type Saved = { id: string; target?: { source?: { file: string; line?: number }; cms?: Cms } };

const ui = (page: Page, sel: string): Locator => page.locator('redline-root').locator(sel);

// Start without this app's notes, so old pins don't sit on the targets.
test.beforeAll(async ({ request }) => {
  const { notes } = await (await request.get(OPTI + '/__redline/notes')).json() as { notes: { id: string }[] };
  for (const n of notes) await request.delete(`${OPTI}/__redline/notes/${n.id}`, { headers: { 'x-redline': '1' } });
});

async function openOverlay(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  // The overlay remembers being open across reloads (sessionStorage).
  if (!(await ui(page, '.bar').isVisible())) await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeVisible();
}

async function mouseAt(page: Page, target: Locator) {
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

async function edit(page: Page, target: Locator, text: string) {
  if (!(await ui(page, '.bar button.on').filter({ hasText: 'Text' }).count())) await page.keyboard.press('t');
  await mouseAt(page, target);
  await expect(ui(page, '.ed')).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(ui(page, '.pop .diff')).toBeVisible();
}

test('optimizely: notes name the CMS content and property, not the template line', async ({ page }) => {
  await openOverlay(page, OPTI);
  const heading = await comment(page, page.getByTestId('heading'), 'Shorter heading.');
  expect(heading.target?.cms).toMatchObject({ property: 'Heading', name: 'Start', type: 'StartPage', lang: 'en' });
  expect(heading.target?.cms?.content).toMatch(/^\d+$/);
  expect(heading.target?.cms?.edit).toContain(`epi.cms.contentdata:///${heading.target?.cms?.content}`);
  expect(heading.target?.source?.file).toBe('dotnet/samples/OptimizelySample/Views/StartPage/Index.cshtml');

  const teaser = await comment(page, page.getByTestId('teaser'), 'Teaser via the epi-property tag helper.');
  expect(teaser.target?.cms).toMatchObject({ content: heading.target?.cms?.content, property: 'Teaser' });

  const block = await comment(page, page.getByTestId('block-heading'), 'Block heading.');
  expect(block.target?.cms).toMatchObject({ property: 'Heading', name: 'Teaser', type: 'TeaserBlock' });
  expect(block.target?.cms?.content).not.toBe(heading.target?.cms?.content);

  const fixed = await comment(page, page.getByTestId('static'), 'Template text.');
  expect(fixed.target?.cms).toMatchObject({ content: heading.target?.cms?.content, name: 'Start' });
  expect(fixed.target?.cms?.property).toBeUndefined();
  expect(fixed.target?.source?.line).toBeGreaterThan(0);
});

test('optimizely: no overlay in edit mode frames', async ({ request }) => {
  const html = await (await request.get(OPTI + '/?epieditmode=true', { headers: { accept: 'text/html' } })).text();
  expect(html).not.toContain('data-redline-client');
  expect(html).not.toContain('data-redline-cms');
});

test('optimizely: text mode saves a content draft for signed-in editors, never publishes', async ({ page, request }) => {
  await openOverlay(page, OPTI);
  const id = (await page.getByTestId('heading').locator('[data-redline-cms]').getAttribute('data-redline-cms'))!.split('|')[0];
  await request.post(`${OPTI}/dev/draft/${id}/reset`);
  const apply = ui(page, '.pop .btn.apply');

  await edit(page, page.getByTestId('heading'), 'Welcome, reviewer');
  await expect(ui(page, '.pop .why')).toContainText(/sign in to Optimizely/);
  await expect(apply).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.goto(OPTI + '/dev/login');
  await openOverlay(page, OPTI);
  await edit(page, page.getByTestId('heading'), 'Welcome, reviewer');
  await expect(apply).toBeEnabled();
  const written = page.waitForResponse(r => r.url().endsWith('/__redline/edit') && r.request().method() === 'POST').then(r => r.json());
  await apply.click();
  expect(await written).toMatchObject({ ok: true, writer: 'optimizely', file: expect.stringMatching(/CMS “Start” › Heading \(draft \d+\)/) });

  const draft = await (await request.get(`${OPTI}/dev/draft/${id}/Heading`)).json();
  expect(draft).toMatchObject({ value: 'Welcome, reviewer', status: 'CheckedOut' });
  // the published page is unchanged
  await page.goto(OPTI);
  await expect(page.getByTestId('heading')).toHaveText('Welcome to the Redline sample');
  await request.post(`${OPTI}/dev/draft/${id}/reset`);
});
