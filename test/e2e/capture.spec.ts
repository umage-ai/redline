// Screenshots on a big page (test/fixtures/vanilla): what ends up in them, and what is left out.
import { test, expect, type Page } from '@playwright/test';
import { FIXTURES } from './fixtures.ts';
import { comment, openOverlay, resetNotes, ui, waitForSave, type SavedNote } from './helpers.ts';

const f = FIXTURES.vanilla;
test.beforeEach(() => resetNotes(f));
// Tab capture without the picker (Chrome); it is only used where a test turns it on.
test.use({ launchOptions: { args: ['--auto-accept-this-tab-capture', '--use-fake-ui-for-media-stream'] } });

/** Thousands of cards below the fold, like a long real page; one image far down. */
const bigPage = (page: Page) => page.evaluate(() => {
  const box = document.createElement('section');
  let html = '';
  for (let i = 0; i < 4000; i++) html += `<article style="padding:8px;border:1px solid #ddd;margin:4px"><h3>Item ${i}</h3><p>Lorem <b>ipsum</b> dolor <a href="#">sit</a></p><ul><li>a</li><li>b</li><li>c</li></ul></article>`;
  box.innerHTML = html + '<img src="/below-the-fold.png" width="40" height="40">';
  document.body.append(box);
});

async function wholePageNote(page: Page, text: string): Promise<SavedNote> {
  await page.keyboard.press('c');
  const b = (await page.locator('h1').boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x + 5, b.y + 5);
  await page.keyboard.up('Shift');
  await page.keyboard.type(text);
  const saved = waitForSave(page);
  await page.keyboard.press('Control+Enter');
  return saved;
}

/** Pixels in the note's screenshot matching an RGB colour (±tolerance). */
const pixels = (page: Page, note: SavedNote, [r, g, b]: number[], tol = 25) => page.evaluate(async ({ src, r, g, b, tol }) => {
  const img = await createImageBitmap(await (await fetch(src)).blob());
  const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) < tol && Math.abs(d[i + 1] - g) < tol && Math.abs(d[i + 2] - b) < tol) n++;
  return n;
}, { src: `/__redline/assets/${note.screenshot!.split('/').pop()}`, r, g, b, tol });

const PIN = [0xff, 0x2d, 0x55];

test('a long page: content below the fold is left out of the render, a menu open in a portal is kept', async ({ page }) => {
  await openOverlay(page, f);
  await bigPage(page);
  // An open menu portalled to the end of <body>: a zero-size root holding a fixed box on screen.
  await page.evaluate(() => {
    const root = document.createElement('div');
    root.innerHTML = '<div style="position:fixed;left:300px;top:300px;width:60px;height:40px;background:#00c853"></div>';
    document.body.append(root);
  });
  const fetched: string[] = [];
  page.on('request', r => fetched.push(r.url()));
  const t0 = Date.now();
  const note = await wholePageNote(page, 'Whole page on a long list');
  expect(Date.now() - t0).toBeLessThan(10_000);   // ~20 s when the whole document was cloned
  expect(fetched.filter(u => u.includes('below-the-fold'))).toEqual([]);
  expect(await pixels(page, note, [0x00, 0xc8, 0x53])).toBeGreaterThan(1000);
});

test('a slow save shows a spinner, then a word on big pages; a fast one shows neither', async ({ page }) => {
  await openOverlay(page, f);
  const toast = ui(page, '.toast');
  const seen: string[] = [];
  await page.exposeFunction('toastSeen', (s: string) => seen.push(s));
  await page.evaluate(() => {
    const el = document.querySelector('redline-root')!.shadowRoot!.querySelector('.toast')!;
    new MutationObserver(() => (window as unknown as { toastSeen(s: string): void }).toastSeen(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await comment(page, page.getByTestId('agent-save'), 'Fast');
  await expect(toast).toContainText('Saved →');
  expect(seen.some(s => s.startsWith('Saving'))).toBe(false);

  await page.route('**/__redline/notes', async r => {
    if (r.request().method() === 'POST') await new Promise(res => setTimeout(res, 2600));
    await r.continue();
  });
  await page.keyboard.press('c');
  const saved = comment(page, page.locator('h1').first(), 'Slow');
  await expect(toast).toContainText('Saving…');
  await expect(ui(page, '.toast.wait')).toBeVisible();
  await expect(toast).toContainText('Large pages take a little longer');
  await saved;
  await expect(toast).toContainText('Saved →');
  await expect(ui(page, '.toast.wait')).toHaveCount(0);
});

test('tab capture: another note\'s pin is not in the shot, even when the page paints slowly', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('redline:tabcapture', '1'));
  await openOverlay(page, f);
  await comment(page, page.getByTestId('agent-save'), 'First note, its pin stays on screen');
  await expect(ui(page, '.pin')).toBeVisible();
  await bigPage(page);
  // A whole-page note: no crop and no red outline, so any pin-coloured pixel is the pin.
  const note = await wholePageNote(page, 'Second note');
  expect(await pixels(page, note, PIN)).toBe(0);
});
