// The overlay against a remote store (docs/PROTOCOL.md, D40-D42), on the vanilla fixture with the
// dev server's /__redline/notes, /config and /events answered by the test: resolved notes show
// green and report "seen" for their author, authors and store links show, and a pushed change
// reaches the page without waiting for the next poll.
import { test, expect, type Page, type Route } from '@playwright/test';
import { FIXTURES } from './fixtures.ts';
import { openOverlay, resetNotes, ui } from './helpers.ts';
import type { Note } from '../../src/shared/types.ts';

const f = FIXTURES.vanilla;
test.beforeEach(() => resetNotes(f));

const target = { selector: '[data-testid="agent-save"]', testid: 'agent-save', tag: 'button', text: 'Save draft', fx: 1, fy: 0 };
const note = (over: Partial<Note>): Note => ({
  id: 'n' + Math.random().toString(36).slice(2, 8), type: 'comment', page: '/', url: f.url + '/', at: '2026-10-16 10:00',
  target, body: 'A note', reply: '', done: false, ...over,
});

/** Serve the given notes as the store's, and record the overlay's PATCHes. */
async function fakeStore(page: Page, notes: () => Note[], events = false) {
  const patches: { id: string; body: unknown }[] = [];
  await page.route('**/__redline/config', async route => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, dir: 'notes.example', events } });
  });
  await page.route(/\/__redline\/notes(\?.*)?$/, route => route.fulfill({ json: { version: String(notes().length) + notes().map(n => n.id + n.done).join(), root: 'notes.example', notes: notes() } }));
  await page.route(/\/__redline\/notes\/[a-z0-9]+$/, async (route: Route) => {
    patches.push({ id: route.request().url().split('/').pop()!, body: route.request().postDataJSON() });
    await route.fulfill({ json: {} });
  });
  return patches;
}

test('a resolved note shows green with its reply; its author marks it seen once; others do not', async ({ page }) => {
  const mineResolved = note({ done: true, resolvedAt: '2026-10-16T10:05:00Z', mine: true, author: 'alice@example.com', reply: 'Fixed in abc123', href: 'https://notes.example/n/1' });
  const theirsResolved = note({ done: true, resolvedAt: '2026-10-16T10:05:00Z', mine: false, author: 'bob@example.com', target: { ...target, selector: '#title', testid: undefined, tag: 'h1', text: 'Agent settings' } });
  const oldDone = note({ done: true, body: 'Closed long ago', target: { ...target, selector: '[data-testid="agent-name"]', testid: 'agent-name', tag: 'input' } });
  const patches = await fakeStore(page, () => [mineResolved, theirsResolved, oldDone]);

  await page.goto(f.url, { waitUntil: 'networkidle' });
  await expect(ui(page, '.pin.resolved')).toHaveCount(2);
  await expect(ui(page, '.pin.done')).toHaveCount(0);   // done without resolvedAt stays hidden
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ id: mineResolved.id, body: { seen: true } });

  await ui(page, '.pin.resolved').first().hover();
  await expect(ui(page, '.tip')).toContainText('alice@example.com');
  await expect(ui(page, '.tip .re')).toHaveText('Fixed in abc123');

  await page.keyboard.press('Alt+Shift+KeyR');
  await page.keyboard.press('n');
  const card = ui(page, `.card[data-id="${mineResolved.id}"]`);
  await expect(card).toHaveClass(/resolved/);
  await expect(card.locator('.meta')).toContainText('alice@example.com');
  await expect(card.locator('a.out')).toHaveAttribute('href', 'https://notes.example/n/1');
  await expect(card.locator('a.out')).toHaveAttribute('rel', 'noopener noreferrer');
  await page.waitForTimeout(600);   // several pin and panel renders later: still one PATCH
  expect(patches.length).toBe(1);
});

test('a store link that is not http(s) is not rendered', async ({ page }) => {
  const bad = note({ author: 'mallory@example.com', href: 'javascript:alert(1)' });
  await fakeStore(page, () => [bad]);
  await openOverlay(page, f);
  await page.keyboard.press('n');
  await expect(ui(page, `.card[data-id="${bad.id}"]`)).toBeVisible();
  await expect(ui(page, `.card[data-id="${bad.id}"] a.out`)).toHaveCount(0);
});

test('a pushed change shows a colleague\'s new note at once, not on the next poll', async ({ page }) => {
  let notes: Note[] = [];
  await fakeStore(page, () => notes, true);
  let push!: () => void;
  const pushed = new Promise<void>(r => { push = r; });
  // The stream answers once the test pushes; then the overlay re-reads /notes.
  await page.route('**/__redline/events', async route => {
    await pushed;
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }, body: 'retry: 60000\n\nevent: change\ndata: {}\n\n' });
  });

  await page.goto(f.url, { waitUntil: 'domcontentloaded' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await expect(ui(page, '.pin')).toHaveCount(0);
  // Past the overlay's first poll (about 1 s after load): the next one is 6 s later.
  await page.waitForTimeout(1500);
  notes = [note({ author: 'bob@example.com', body: 'From a colleague' })];
  const t = Date.now();
  push();
  await expect(ui(page, '.pin')).toHaveCount(1, { timeout: 3000 });
  // The overlay is closed, so its poll runs every 6 s: well under that means the push did it.
  expect(Date.now() - t).toBeLessThan(3000);
});

test('without a change feed the overlay never opens /events', async ({ page }) => {
  let opened = 0;
  await page.route('**/__redline/events', route => { opened++; return route.abort(); });
  await page.goto(f.url, { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await page.waitForTimeout(300);
  expect(opened).toBe(0);
});
