// Phones and touch: a Pixel 8 Pro at 125% display size is ~360 CSS px wide (test/fixtures/vanilla).
import { test, expect, type Page, type Locator } from '@playwright/test';
import { FIXTURES } from './fixtures.ts';
import { readPage, resetNotes, ui, waitForSave } from './helpers.ts';

const f = FIXTURES.vanilla;
const W = 360;
test.use({ viewport: { width: W, height: 780 }, deviceScaleFactor: 2.8, isMobile: true, hasTouch: true });
test.beforeEach(() => resetNotes(f));

async function openByTap(page: Page) {
  await page.goto(f.url, { waitUntil: 'networkidle' });
  await ui(page, '.launcher').tap();
  await expect(ui(page, '.bar')).toBeVisible();
}

async function fitsViewport(l: Locator) {
  const b = (await l.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(W);
}

test('toolbar, hint and popover fit a phone; tap to comment, the app never sees the tap', async ({ page }) => {
  await openByTap(page);
  await fitsViewport(ui(page, '.bar'));
  await expect(ui(page, '.bar kbd').first()).toBeHidden();
  await ui(page, '.bar button', ).filter({ hasText: 'Comment' }).tap();
  await expect(ui(page, '.hint')).toContainText('Tap an element');
  await fitsViewport(ui(page, '.hint'));

  await page.getByTestId('agent-save').tap();
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await fitsViewport(ui(page, '.pop'));
  await page.keyboard.type('Bigger tap target on mobile.');
  const saved = waitForSave(page);
  await ui(page, '.pop .btn.primary').tap();
  const note = await saved;
  expect(note.target?.testid).toBe('agent-save');
  expect(note.viewport?.[0]).toBe(W);
  expect(await page.evaluate(() => (window as unknown as { clicked?: number }).clicked)).toBeUndefined();
});

test('a finger can still scroll the page while picking (L15)', async ({ page }) => {
  await openByTap(page);
  await ui(page, '.bar button').filter({ hasText: 'Comment' }).tap();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 180, y }] });
  await touch('touchStart', 600);
  for (let y = 580; y >= 200; y -= 20) await touch('touchMove', y);
  await touch('touchEnd', 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  await expect(ui(page, '.pop')).toHaveCount(0);     // a scroll is not a pick
});

test('text mode: tapping outside the editor finishes the edit', async ({ page }) => {
  await openByTap(page);
  await ui(page, '.bar button').filter({ hasText: 'Text' }).tap();
  await page.locator('p.lead').tap();
  await expect(ui(page, '.ed')).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Shorter lead.');
  await page.locator('h2').tap();
  await expect(ui(page, '.pop .diff')).toContainText('Shorter lead.');
  await fitsViewport(ui(page, '.pop'));
});

test('notes panel is full width with actions visible; tab capture is hidden without getDisplayMedia', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', { value: undefined }); });
  await openByTap(page);
  await ui(page, '.bar button').filter({ hasText: 'Comment' }).tap();
  await page.locator('h1').tap();
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type('Title too long for phones.');
  const saved = waitForSave(page);
  await ui(page, '.pop .btn.primary').tap();
  await saved;

  await ui(page, '.bar button').filter({ hasText: 'Notes' }).tap();
  await expect(ui(page, '.panel')).toBeVisible();
  expect((await ui(page, '.panel').boundingBox())!.width).toBe(W);
  await expect(ui(page, '.panel footer')).not.toContainText('tab capture');
  const done = ui(page, '.card .acts button[title="Mark done"]');
  await expect(ui(page, '.card .acts')).toHaveCSS('opacity', '1');
  await done.tap();
  await expect.poll(() => readPage(f)).toContain('### [x] Comment');
});

test('sketch on touch: tools fit, are tappable above the canvas, a tap places a label, a finger draws', async ({ page }) => {
  await openByTap(page);
  await ui(page, '.bar button').filter({ hasText: 'Sketch' }).tap();
  await fitsViewport(ui(page, '.tools'));
  await ui(page, '.tools button').filter({ hasText: 'Text' }).tap();    // the canvas used to cover the toolbar (L16)
  await page.touchscreen.tap(300, 500);
  await expect(ui(page, '.rl-sketch-input')).toBeFocused();            // created on pointerup so the keyboard can open
  await fitsViewport(ui(page, '.rl-sketch-input'));
  await page.keyboard.type('here');
  await page.keyboard.press('Enter');
  await ui(page, '.tools button').filter({ hasText: 'Box' }).tap();
  await ui(page, '.tools .sw.current').tap();
  await fitsViewport(ui(page, '.tools .palette'));
  await ui(page, '.tools .palette .sw[aria-label="Amber"]').tap();
  // Raw CDP touches: Playwright has no touch drag. (Chrome then drops the next synthetic tap's click, so draw last.)
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', 60, 300);
  for (let i = 1; i <= 5; i++) await touch('touchMove', 60 + i * 40, 300 + i * 20);
  await touch('touchEnd', 260, 400);
  await expect(ui(page, '.rl-sketch path')).toHaveCount(2);            // shadow + ink of one box
  await expect(ui(page, '.rl-sketch path[stroke-width="3"]')).toHaveAttribute('stroke', '#ffb020');
  await expect(ui(page, '.rl-sketch text')).toHaveText(['here']);
});

test('pins of full-width elements stay on screen', async ({ page }) => {
  await openByTap(page);
  await ui(page, '.bar button').filter({ hasText: 'Comment' }).tap();
  await page.locator('header').tap();
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type('Header too tall on phones.');
  const saved = waitForSave(page);
  await ui(page, '.pop .btn.primary').tap();
  await saved;
  const pin = (await ui(page, '.pin').boundingBox())!;
  expect(pin.x + pin.width).toBeLessThanOrEqual(W);
  expect(pin.y).toBeGreaterThanOrEqual(0);
});
