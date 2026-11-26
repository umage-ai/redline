// @umage.ai/redline-voice (D71) in a real browser: Chrome's fake microphone, a stand-in transcriber
// (test/fixtures/voice). A voice note saves, its status goes to done and the transcript becomes its body;
// a session keeps its toolbar while pointing (extension API v8), and writes its folder and timeline.
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePage } from '../../src/server/format.ts';
import { FIXTURES } from './fixtures.ts';
import { mouseAt, openOverlay, resetNotes, ui } from './helpers.ts';

const f = FIXTURES.voice;
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone'],
});
test.beforeEach(() => resetNotes(f));

const notes = async (slug = 'index') => parsePage(await fs.readFile(path.join(f.dir, '.redline/pages', `${slug}.md`), 'utf8').catch(() => ''));

test('a voice note: pick, talk, Enter; the transcript replaces the pending body and the card says so', async ({ page }) => {
  await openOverlay(page, f);
  await expect(ui(page, '.bar button').filter({ hasText: 'Voice' })).toBeVisible();
  await page.keyboard.press('v');
  await mouseAt(page, page.getByTestId('pay'));
  expect(await page.evaluate(() => (window as { paid?: number }).paid)).toBeUndefined();
  await expect(ui(page, '.bar [data-toolbar="voice-note"]')).toBeVisible();
  await expect(ui(page, '.bar [data-toolbar="voice-note"]')).toContainText('On button “Pay now”');
  await page.waitForTimeout(1200);
  const saved = page.waitForResponse(r => r.url().endsWith('/__redline/p/voice/notes'));
  await page.keyboard.press('Enter');
  const note = await (await saved).json();
  expect(note.meta.voice.status).toBe('queued');
  expect(note.target.testid).toBe('pay');
  expect(note.screenshot).toMatch(/\.png$/);
  await expect.poll(async () => (await notes())[0]?.body).toMatch(/^Make this button green\. And take a picture\.\n\n🎙 \[Recording \(0:01\)\]/);
  const [n] = await notes();
  const audio = path.join(f.dir, '.redline', (n.meta!.voice as { audio: string }).audio);
  expect((await fs.stat(audio)).size).toBeGreaterThan(1000);
  await page.keyboard.press('n');
  await expect(ui(page, '.vx-st')).toContainText('Transcribed · fake-whisper');
  await expect(ui(page, '.vx-st audio')).toHaveAttribute('src', /\/__redline\/p\/voice\/audio\/[a-z0-9]+\.webm$/);
});

test('a session: Point keeps the toolbar, S is a screenshot not sketch, clicks and routes are logged, Finish writes the folder', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('r');
  const bar = ui(page, '.bar [data-toolbar="voice-session"]');
  await expect(bar).toBeVisible();
  await page.keyboard.press(' ');
  await expect(bar.getByText('Finish')).toBeVisible();
  await page.keyboard.press('p');
  await expect(bar).toBeVisible();                                      // the mode belongs to the toolbar (v8)
  await expect(bar.locator('button.on')).toContainText('Point');
  await mouseAt(page, page.getByTestId('pay'));
  expect(await page.evaluate(() => (window as { paid?: number }).paid)).toBeUndefined();
  await expect(ui(page, '.vx-card .ev').first()).toContainText('button “Pay now”');
  await page.keyboard.press('s');                                       // the toolbar's key (v8), not Sketch
  await expect(bar).toBeVisible();
  await expect(ui(page, '.vx-card .ev')).toHaveCount(2);
  await page.keyboard.press('d');                                       // ink over the page; the app sees nothing
  const pay = (await page.getByTestId('pay').boundingBox())!;
  await page.mouse.move(pay.x - 10, pay.y - 10);
  await page.mouse.down();
  await page.mouse.move(pay.x + pay.width + 10, pay.y + pay.height / 2, { steps: 8 });
  await page.mouse.move(pay.x - 10, pay.y + pay.height + 10, { steps: 8 });
  await page.mouse.up();
  await page.mouse.click(pay.x + 5, pay.y + 5);
  expect(await page.evaluate(() => (window as { paid?: number }).paid)).toBeUndefined();
  await expect(ui(page, '.vx-card .ev').last()).toContainText('drawing');
  await page.keyboard.press('b');
  await expect(page.locator('[data-redline-voice-ink]')).toHaveCount(0);
  await page.getByTestId('done-link').click();                         // the app works while browsing
  await expect(page).toHaveURL(/#\/done$/);
  await expect(ui(page, '.vx-card .ev').last()).toContainText('went to /');
  await page.getByTestId('done-link').focus();                         // Space/Enter on the app's focused link are the app's
  await page.keyboard.press(' ');
  await page.keyboard.press('Enter');
  await expect(bar.getByText('Pause')).toBeVisible();
  const saved = page.waitForResponse(r => r.url().endsWith('/__redline/p/voice/sessions'));
  await bar.getByText('Finish').click();
  const r = await (await saved).json();
  expect(r.dir).toMatch(/^\.redline\/sessions\/\d{4}-\d{2}-\d{2}-\d{4}-home$/);
  const dir = path.join(f.dir, r.dir);
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8').catch(() => '{}')).transcript?.status).toBe('done');
  const md = await fs.readFile(path.join(dir, 'session.md'), 'utf8');
  expect(md).toMatch(/\*\*0:00\*\* “Make this button green\.”/);
  expect(md).toMatch(/👉 \*\*Pointed at\*\* `button` “Pay now” · \[data-testid="pay"\]/);
  expect(md).toMatch(/!\[point at 0:0\d\]\(shots\/01\.png\)/);
  expect(md).toMatch(/📸 \*\*Screenshot\*\*/);
  expect(md).toMatch(/🖱 Clicked `a` “Go to the receipt”/);
  expect(md).toMatch(/\*\*1:00\*\* “And take a picture\.”/);
  expect(md).toMatch(/✏️ \*\*Drew on the page\*\* over `button` “Pay now”/);
  expect((await fs.readdir(path.join(dir, 'shots'))).length).toBe(3);
  // The pointer note is updated after session.json says done, so wait for it (a read mid-write finds no note).
  await expect.poll(async () => (await notes()).find(n => n.id === r.note)?.body ?? '').toContain('transcribed by fake-whisper');
  const [pointer] = await notes();
  expect(pointer.id).toBe(r.note);
  expect(pointer.body).toContain(`[${r.dir}/session.md]`);
});

test('Esc stops pointing but stays in the session; Discard asks once more', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('r');
  const bar = ui(page, '.bar [data-toolbar="voice-session"]');
  await page.keyboard.press(' ');
  await expect(bar.getByText('Finish')).toBeVisible();
  await page.keyboard.press('p');
  await expect(bar.locator('button.on')).toContainText('Point');
  await page.keyboard.press('Escape');
  await expect(bar).toBeVisible();
  await expect(bar.locator('button.on')).toContainText('Browse');
  await bar.locator('button.danger').click();
  await expect(bar.locator('button.danger')).toHaveText('Discard?');
  await bar.locator('button.danger').click();
  await expect(bar.getByText('Start recording')).toBeVisible();
  await expect(ui(page, '.launcher')).toBeAttached();
  const toast = ui(page, '.toast');                                     // above the toolbar's card, not under it
  await expect(toast).toContainText('Session discarded');
  const [t, c] = [(await toast.boundingBox())!, (await ui(page, '.attach').boundingBox())!];
  expect(t.y + t.height).toBeLessThanOrEqual(c.y);
});

test('no microphone: the reason shows in the toolbar card, for a session and a voice note', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
  });
  await openOverlay(page, f);
  await page.keyboard.press('r');
  const bar = ui(page, '.bar [data-toolbar="voice-session"]');
  await page.keyboard.press(' ');
  await expect(ui(page, '.attach .err')).toHaveText('No microphone found. Connect one, then try again.');
  await expect(bar.getByText('Try again')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('v');
  await mouseAt(page, page.getByTestId('pay'));
  await expect(ui(page, '.bar [data-toolbar="voice-note"]')).toContainText('Can’t record');
  await expect(ui(page, '.attach .err')).toHaveText('No microphone found. Connect one, then try again.');
  await page.keyboard.press('Escape');
  await expect(ui(page, '.bar [data-toolbar="voice-note"]')).toHaveCount(0);
});
