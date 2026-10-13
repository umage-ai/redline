// Pin a throwaway note on an already-running app, to check an integration by hand:
//   npm run smoke -- http://localhost:4321/some/page "css selector" [label]
// Prints the saved note's target (source, components, selector) and writes
// test-results/smoke-<label>-{hover,panel}.png. Delete the note afterwards in the panel.
import { chromium } from '@playwright/test';

const [url, selector = 'h1', label = 'smoke'] = process.argv.slice(2);
if (!url) { console.log('Usage: npm run smoke -- <url> [selector] [label]'); process.exit(1); }

const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM ? undefined : 'chrome' });
const page = await browser.newPage({ viewport: { width: 1366, height: 860 }, ignoreHTTPSErrors: true });
const ui = sel => page.locator('redline-root').locator(sel);
try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await ui('.rl').waitFor({ state: 'attached', timeout: 20_000 });
  await page.keyboard.press('Alt+Shift+KeyR');
  await page.keyboard.press('c');
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  await page.mouse.move(b.x + Math.min(20, b.width / 2), b.y + Math.min(10, b.height / 2));
  await page.screenshot({ path: `test-results/smoke-${label}-hover.png` });
  await page.mouse.click(b.x + Math.min(20, b.width / 2), b.y + Math.min(10, b.height / 2));
  await ui('.pop textarea').waitFor();
  await page.keyboard.type('Smoke test note — safe to delete.');
  const saved = page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST');
  await page.keyboard.press('Control+Enter');
  const note = await (await saved).json();
  console.log(JSON.stringify({ file: note.file, target: { ...note.target, html: undefined }, screenshot: note.screenshot }, null, 2));
  await page.keyboard.press('n');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `test-results/smoke-${label}-panel.png` });
} finally {
  await browser.close();
}
