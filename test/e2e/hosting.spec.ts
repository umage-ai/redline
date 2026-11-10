// Hosting the self-starting overlay somewhere else than /__redline on the page's own origin: an API
// under another base (`apiBase`, `data-api`, `window.redlineConfig`, D60), and an API on another origin
// with cookies or a header hook, behind the opt-in CORS (D60). Each test starts its own servers (serve.ts).
import { test, expect } from '@playwright/test';
import { ui } from './helpers.ts';
import { APP_PAGE, expectRoundTrip, serve, servePage, type Served } from './serve.ts';

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

test.describe('API on another origin (D60)', () => {
  let api: Served | undefined, host: { url: string; close(): Promise<void> } | undefined;
  test.afterEach(async () => { await host?.close(); await api?.close(); api = host = undefined; });

  /** The page's server (no Redline) and the API's (CORS for the page's origin only, a feed, a sign-in check). */
  async function start(auth: (req: import('node:http').IncomingMessage) => boolean, head: (api: string) => string) {
    let html = '';
    host = await servePage(() => html);
    api = await serve({ cors: [host.url], feed: true, inject: false, auth });
    html = APP_PAGE(head(api.url + '/__redline'));
  }

  test("credentials: 'include': cookies on every call and the feed; comment, ETag polling, assets, live replies", async ({ page }) => {
    await start(req => /(^|;\s*)rl_session=ok/.test(req.headers.cookie ?? ''), api =>
      `<script>document.cookie = 'rl_session=ok; path=/'; window.redlineConfig = { credentials: 'include' };</script>` +
      `<script type="module" src="${api}/client.js" data-api="${api}"></script>`);
    // The API answers this page's origin and no other.
    const pre = await fetch(api!.url + '/__redline/notes', { method: 'OPTIONS', headers: { origin: host!.url, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-redline, content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toBe('x-redline, authorization, content-type, if-none-match');
    const other = await fetch(api!.url + '/__redline/notes', { method: 'OPTIONS', headers: { origin: 'http://evil.test' } });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    await page.goto(host!.url + '/');
    await expectRoundTrip(page, api!, '/__redline', { live: true });
  });

  test('a header hook: a bearer token on every call, images as blob URLs, the feed read with fetch', async ({ page }) => {
    let asked = 0;
    await page.exposeFunction('countAsk', () => { asked++; });
    await start(req => req.headers.authorization === 'Bearer t0ken', api =>
      `<script>window.redlineConfig = { apiBase: '${api}', headers: async () => { await window.countAsk(); return { authorization: 'Bearer t0ken' }; } };</script>` +
      `<script type="module" src="${api}/client.js"></script>`);
    await page.goto(host!.url + '/');
    await expectRoundTrip(page, api!, '/__redline', { live: true, blob: true });
    expect(asked).toBeGreaterThan(4);   // asked before each call: config, notes, create, the asset, the feed…
  });

  test('without CORS the cross-origin page gets no overlay data, and same-origin setups send no CORS headers', async ({ page }) => {
    api = await serve();
    const same = await fetch(api.url + '/__redline/config', { headers: { origin: 'http://127.0.0.1:1' } });
    expect(same.headers.get('access-control-allow-origin')).toBeNull();
    host = await servePage(APP_PAGE(`<script type="module" src="${api.url}/__redline/client.js" data-api="${api.url}/__redline"></script>`));
    const failed: string[] = [];
    page.on('requestfailed', r => failed.push(new URL(r.url()).pathname));
    await page.goto(host.url + '/');
    await expect.poll(() => failed).toContain('/__redline/client.js');   // a module script needs CORS
  });
});
