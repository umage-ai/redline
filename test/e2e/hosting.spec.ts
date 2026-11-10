// Hosting the self-starting overlay somewhere else than /__redline on the page's own origin (D60): an
// API under another base (`apiBase`, `data-api`, `window.redlineConfig`). Each test starts its own
// node:http server with the handler from src (dist/client.js as the overlay), in a temp root.
import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, type RedlineOptions } from '../../src/server/handler.ts';
import { ui } from './helpers.ts';

const clientFile = fileURLToPath(new URL('../../dist/client.js', import.meta.url));

export const APP_PAGE = (head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Hosted</title>${head}</head>
<body><h1 id="title">Hosted app</h1><button data-testid="save" onclick="window.clicked=(window.clicked||0)+1">Save draft</button></body></html>`;

export interface Served { url: string; root: string; close(): Promise<void> }

/** A node:http server: Redline's API and injector (or none), then `page` for every other GET. */
export async function serve(opts: RedlineOptions & { page?: (req: http.IncomingMessage) => string | undefined; inject?: boolean } = {}): Promise<Served> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-host-'));
  const { api, inject } = createHandler({ ...opts, root, serverRoot: root, clientFile });
  const server = http.createServer((req, res) => {
    const page = () => {
      const body = opts.page?.(req) ?? APP_PAGE();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    api(req, res, () => (opts.inject === false ? page() : inject(req, res, page)));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url, root,
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); },
  };
}

/** Comment on the Save button through the overlay; returns the saved note (the POST's answer). */
export async function commentOn(page: Page, text: string, apiPath: string) {
  await expect(ui(page, '.launcher')).toBeAttached();
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeVisible();
  await page.keyboard.press('c');
  const b = (await page.getByTestId('save').boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type(text);
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === `${apiPath}/notes` && r.request().method() === 'POST');
  await page.keyboard.press('Control+Enter');
  return (await saved).json() as Promise<{ id: string; screenshot?: string }>;
}

/** An agent's reply in the markdown (as SKILL.md says), then the overlay must show it without a reload. */
export async function replyAsAgent(root: string, text: string) {
  const file = path.join(root, '.redline/pages/index.md');
  const md = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, md.replace(/^### \[ \]/m, '### [x]').replace('"Save as draft".\n', `"Save as draft".\n\n> ${text}\n`));
}

/** The note shows, its screenshot loads from the API, and a reply written meanwhile reaches the panel. */
export async function expectRoundTrip(page: Page, served: Served, apiPath: string) {
  const etags: string[] = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.pathname === `${apiPath}/notes` && r.method() === 'GET') { const h = r.headers()['if-none-match']; if (h) etags.push(h); } });
  const note = await commentOn(page, 'Rename to "Save as draft".', apiPath);
  expect(note.screenshot).toBeTruthy();
  await expect(ui(page, '.pin')).toHaveCount(1);
  await page.keyboard.press('n');
  const img = ui(page, '.card img');
  await expect(img).toHaveAttribute('src', new RegExp(`${apiPath}/assets/`));
  await expect.poll(() => img.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await replyAsAgent(served.root, 'Renamed in the template.');
  await ui(page, '.filters label').filter({ hasText: 'Show done' }).click();
  await expect(ui(page, '.card .reply')).toContainText('Renamed in the template.', { timeout: 15_000 });
  expect(etags.length).toBeGreaterThan(0);   // polling asks with If-None-Match (304 while nothing changed)
  expect(await page.evaluate(() => (window as { clicked?: number }).clicked ?? 0)).toBe(0);
}

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
