// Fewer open streams (D72): browsers allow 6 connections per server over HTTP/1.1, for every tab, and
// each EventSource holds one. A tab keeps one stream (live pages + change feed) while visible; the agent
// status feed only while the overlay is open; a hidden tab lets go after 15 s and catches up on return.
// When a plain request can't get through either, the overlay says why.
import { test, expect, type Page } from '@playwright/test';
import { FIXTURES } from './fixtures.ts';
import { ui } from './helpers.ts';

const f = FIXTURES.vanilla;

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  // Every EventSource the page opens, to see which are still open.
  await page.addInitScript(() => {
    const all: (EventSource & { at: string })[] = [];
    (window as unknown as { streams: () => string[] }).streams = () =>
      all.filter(e => e.readyState !== EventSource.CLOSED).map(e => new URL(e.at, location.href).pathname).sort();
    const ES = window.EventSource;
    window.EventSource = class extends ES {
      at: string;
      constructor(url: string | URL, init?: EventSourceInit) { super(url, init); this.at = String(url); all.push(this as never); }
    } as typeof EventSource;
  });
});

const streams = (page: Page) => page.evaluate(() => (window as unknown as { streams: () => string[] }).streams());
const visibility = (page: Page, v: 'visible' | 'hidden') => page.evaluate(v => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => v === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}, v);

test('one stream per tab; the agent feed only while open; a hidden tab lets go after 15 s and catches up on return', async ({ page }) => {
  await page.goto(f.url, { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await expect.poll(() => streams(page)).toEqual(['/__redline/live']);   // closed overlay: live pages only
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect.poll(() => streams(page)).toEqual(['/__redline/agent/stream', '/__redline/live']);
  await page.keyboard.press('Alt+Shift+KeyR');
  await page.clock.fastForward(16_000);
  await expect.poll(() => streams(page)).toEqual(['/__redline/live']);
  await visibility(page, 'hidden');
  await page.clock.fastForward(10_000);
  expect(await streams(page)).toEqual(['/__redline/live']);              // still within the grace
  await page.clock.fastForward(6_000);
  await expect.poll(() => streams(page)).toEqual([]);
  const caughtUp = page.waitForRequest(r => new URL(r.url()).pathname === '/__redline/notes');
  await visibility(page, 'visible');
  await expect.poll(() => streams(page)).toEqual(['/__redline/live']);
  await caughtUp;
});

test('no connection left: the stream lets go and a toast explains the browser limit', async ({ page }) => {
  await page.goto(f.url, { waitUntil: 'networkidle' });
  await expect.poll(() => streams(page)).toEqual(['/__redline/live']);
  await visibility(page, 'hidden');
  await page.clock.fastForward(16_000);
  await expect.poll(() => streams(page)).toEqual([]);
  // From now on nothing reaches the dev server, as when other tabs hold all six connections.
  await page.route(u => u.pathname.startsWith('/__redline/'), () => { /* never answered */ });
  await visibility(page, 'visible');
  await page.clock.fastForward(5_500);                                  // not connected: probe
  await page.clock.fastForward(5_500);                                  // the probe got no answer either
  await expect(ui(page, '.toast')).toContainText('6 per server');
  expect(await streams(page)).toEqual([]);
});
