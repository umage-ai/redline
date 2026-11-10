// Hosting the self-starting overlay somewhere else than /__redline on the page's own origin (D60): an
// API under another base (`apiBase`, `data-api`, `window.redlineConfig`). Each test starts its own
// server (serve.ts).
import { test, expect } from '@playwright/test';
import { ui } from './helpers.ts';
import { APP_PAGE, expectRoundTrip, serve, type Served } from './serve.ts';

test.describe('API base (D60)', () => {
  let s: Served | undefined;
  test.afterEach(async () => { await s?.close(); s = undefined; });

  test('apiBase: the API under /x/__redline, the tag carries data-api; comment, ETag polling, assets, replies', async ({ page }) => {
    s = await serve({ apiBase: '/x/__redline/' });
    const html = await (await fetch(s.url + '/', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('<script type="module" src="/x/__redline/client.js" data-api="/x/__redline" data-redline-client></script>');
    expect(await (await fetch(s.url + '/__redline/config')).text()).not.toContain('hotkey');   // the app's page, not the API
    await page.goto(s.url + '/');
    await expectRoundTrip(page, s, '/x/__redline');
  });

  test('window.redlineConfig.apiBase wins over data-api, for a hand-written script tag', async ({ page }) => {
    s = await serve({ apiBase: '/y/__redline', inject: false, page: () => APP_PAGE(
      `<script>window.redlineConfig = { apiBase: '/y/__redline' }</script><script type="module" src="/y/__redline/client.js" data-api="/nowhere"></script>`) });
    await page.goto(s.url + '/');
    await expectRoundTrip(page, s, '/y/__redline');
  });

  test('with nothing set, the tag and the calls are as before', async ({ page }) => {
    s = await serve();
    const html = await (await fetch(s.url + '/', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain('<script type="module" src="/__redline/client.js" data-redline-client></script>');
    const calls: string[] = [];
    page.on('request', r => calls.push(new URL(r.url()).pathname));
    await page.goto(s.url + '/');
    await expect(ui(page, '.launcher')).toBeAttached();
    expect(calls).toContain('/__redline/config');
    expect(calls).toContain('/__redline/notes');
  });
});
