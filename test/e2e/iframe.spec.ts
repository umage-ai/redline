// The overlay inside an iframe (D60): off unless the host opts in; with it, each frame has its own
// overlay that picks without the frame's app seeing the click, the hotkey toggles the focused one, a
// same-origin parent can toggle the frame's by postMessage, and the two keep their own view state.
import { test, expect, type Page } from '@playwright/test';
import { ui } from './helpers.ts';
import { APP_PAGE, serve, type Served } from './serve.ts';

const PARENT = `<!doctype html><html><head><meta charset="utf-8"><title>Parent</title></head><body style="margin:0">
<h1 id="ptitle" style="margin:8px">Parent page</h1>
<button data-testid="parent-btn" onclick="window.parentClicks=(window.parentClicks||0)+1">Parent button</button>
<iframe src="/frame" style="display:block;width:900px;height:420px;border:1px solid #ccc;margin-top:8px"></iframe>
</body></html>`;

const page_ = (req: { url?: string }) => req.url?.startsWith('/frame') ? APP_PAGE() : PARENT;
const inFrame = (page: Page, sel: string) => page.frameLocator('iframe').locator('redline-root').locator(sel);
const frameApp = (page: Page) => page.frameLocator('iframe');

let s: Served;
test.afterEach(() => s.close());

/** Focus a document by clicking a plain heading in it (no overlay open there, so the app gets it). */
async function focus(page: Page, where: 'parent' | 'frame') {
  const el = where === 'parent' ? page.locator('#ptitle') : frameApp(page).locator('#title');
  const b = (await el.boundingBox())!;
  await page.mouse.click(b.x + 4, b.y + b.height / 2);
}

test('without the opt-in, the frame has no overlay (the parent has its own)', async ({ page }) => {
  s = await serve({ page: page_ });
  await page.goto(s.url + '/', { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await expect(frameApp(page).locator('#title')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(frameApp(page).locator('redline-root')).toHaveCount(0);
});

test('opted in: comment mode works in the frame, its app sees no clicks; the note is the frame page', async ({ page }) => {
  s = await serve({ page: page_, allowInIframe: true });
  await page.goto(s.url + '/', { waitUntil: 'networkidle' });
  await expect(inFrame(page, '.launcher')).toBeAttached();
  await focus(page, 'frame');
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect(inFrame(page, '.bar')).toBeVisible();
  await expect(ui(page, '.bar')).toBeHidden();             // the hotkey reached the focused frame only
  await page.keyboard.press('c');
  const b = (await frameApp(page).getByTestId('save').boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(inFrame(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type('Framed note');
  const saved = page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST');
  await page.keyboard.press('Control+Enter');
  const note = await (await saved).json() as { page: string; url: string; target?: { tag?: string } };
  expect(note.page).toBe('/frame');
  expect(note.url).toBe(s.url + '/frame');
  expect(note.target?.tag).toBe('button');
  expect(await page.frames()[1].evaluate(() => (window as { clicked?: number }).clicked ?? 0)).toBe(0);
  await expect(inFrame(page, '.pin')).toHaveCount(1);
  await expect(ui(page, '.pin')).toHaveCount(0);            // the parent page has no notes of its own
});

test('parent and frame overlays coexist: own hotkey target, own clicks, own view state; the parent can toggle the frame', async ({ page }) => {
  s = await serve({ page: page_, allowInIframe: true });
  await page.goto(s.url + '/', { waitUntil: 'networkidle' });
  await expect(inFrame(page, '.launcher')).toBeAttached();

  // The frame's overlay in comment mode doesn't touch the parent: its app gets the click.
  await focus(page, 'frame');
  await page.keyboard.press('Alt+Shift+KeyR');
  await page.keyboard.press('c');
  await expect(inFrame(page, '.bar button.on')).toHaveCount(1);
  await page.getByTestId('parent-btn').click();
  expect(await page.evaluate(() => (window as { parentClicks?: number }).parentClicks)).toBe(1);

  // Focus in the parent: the hotkey opens the parent's overlay; the frame's stays as it was.
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeVisible();
  await expect(inFrame(page, '.bar button.on')).toHaveCount(1);
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeHidden();

  // Each keeps its own view state across a reload (same-origin frames share the parent's storage).
  await page.reload({ waitUntil: 'networkidle' });
  await expect(inFrame(page, '.bar')).toBeVisible();
  await expect(ui(page, '.launcher')).toBeAttached();
  await expect(ui(page, '.bar')).toBeHidden();

  // A same-origin parent toggles the frame's overlay by postMessage.
  await page.evaluate(() => window.frames[0].postMessage({ redline: 'toggle' }, location.origin));
  await expect(inFrame(page, '.bar')).toBeHidden();
  await page.evaluate(() => window.frames[0].postMessage({ redline: 'open' }, location.origin));
  await expect(inFrame(page, '.bar')).toBeVisible();
});

test('a page opts its frame in by itself: data-allow-iframe, and data-launcher="false" hides the frame launcher', async ({ page }) => {
  s = await serve({ page: req => req.url?.startsWith('/frame')
    ? APP_PAGE('<script type="module" src="/__redline/client.js" data-allow-iframe data-launcher="false"></script>') : PARENT,
  inject: false });
  await page.goto(s.url + '/', { waitUntil: 'networkidle' });
  await expect(frameApp(page).locator('redline-root')).toHaveCount(1);
  await expect(inFrame(page, '.launcher')).toBeHidden();
  await page.evaluate(() => window.frames[0].postMessage({ redline: 'open' }, location.origin));
  await expect(inFrame(page, '.bar')).toBeVisible();
});
