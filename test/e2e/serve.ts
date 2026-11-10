// Servers started by a test (hosting.spec.ts, enrich.spec.ts): node:http with the handler from src
// (dist/client.js as the overlay) in a temp root, and the steps those specs share.
import { expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, type RedlineOptions } from '../../src/server/handler.ts';
import { createStore, type NoteStore } from '../../src/server/store.ts';
import { ui } from './helpers.ts';

const clientFile = fileURLToPath(new URL('../../dist/client.js', import.meta.url));

export const APP_PAGE = (head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Hosted</title>${head}</head>
<body><h1 id="title">Hosted app</h1><button data-testid="save" onclick="window.clicked=(window.clicked||0)+1">Save draft</button></body></html>`;

/** `feeds()`: change-feed subscriptions open now (an authenticated `/events` stream). */
export interface Served { url: string; root: string; close(): Promise<void>; change(): void; feeds(): number }

export interface ServeOptions extends RedlineOptions {
  page?: (req: http.IncomingMessage) => string | undefined;
  /** false: no script injected (the page brings its own tag). */
  inject?: boolean;
  /** A change feed on the markdown store (`/events`), fired by `change()`, as a shared store would. */
  feed?: boolean;
  /** Turn a call away with 401 unless this says yes (client.js and preflights always pass, as a public script would). */
  auth?: (req: http.IncomingMessage) => boolean;
}

/** A node:http server: Redline's API and injector (or none), then `page` for every other GET. */
export async function serve(opts: ServeOptions = {}): Promise<Served> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-host-'));
  const listeners = new Set<() => void>();
  const store = opts.feed ? ({ root: r, dir }: { root: string; dir: string }): NoteStore =>
    Object.assign(createStore({ root: r, dir }), { subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; } })
    : opts.store;
  const { api, inject } = createHandler({ ...opts, store, root, serverRoot: root, clientFile });
  const server = http.createServer((req, res) => {
    const page = () => {
      const body = opts.page?.(req) ?? APP_PAGE();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const open = req.method === 'OPTIONS' || /\/client\.js$/.test(req.url ?? '');
    if (opts.auth && !open && !opts.auth(req)) {
      res.writeHead(401, { 'content-type': 'application/json', 'access-control-allow-origin': String(req.headers.origin ?? '*') });
      res.end('{"error":"sign in"}');
      return;
    }
    api(req, res, () => (opts.inject === false ? page() : inject(req, res, page)));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url, root,
    change: () => { for (const fn of listeners) fn(); },
    feeds: () => listeners.size,
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); },
  };
}

/** A plain page server with no Redline at all (the host on another origin). */
export async function servePage(html: string | (() => string)): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(typeof html === 'function' ? html() : html); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); },
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

/**
 * The note shows, its screenshot loads from the API, and a reply written meanwhile reaches the panel: by
 * polling (2 s while open), or with `live` through the change feed (polling then waits 30 s, so only the feed is in time).
 */
export async function expectRoundTrip(page: Page, served: Served, apiPath: string, o: { live?: boolean; blob?: boolean } = {}) {
  const etags: string[] = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.pathname === `${apiPath}/notes` && r.method() === 'GET') { const h = r.headers()['if-none-match']; if (h) etags.push(h); } });
  const note = await commentOn(page, 'Rename to "Save as draft".', apiPath);
  expect(note.screenshot).toBeTruthy();
  await expect(ui(page, '.pin')).toHaveCount(1);
  await page.keyboard.press('n');
  const img = ui(page, '.card img');
  await expect(img).toHaveAttribute('src', o.blob ? /^blob:/ : new RegExp(`${apiPath}/assets/`));
  await expect.poll(() => img.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  if (o.live) await expect.poll(() => served.feeds()).toBeGreaterThan(0);   // the feed got through the auth
  await replyAsAgent(served.root, 'Renamed in the template.');
  if (o.live) served.change();
  await ui(page, '.filters label').filter({ hasText: 'Show done' }).click();
  await expect(ui(page, '.card .reply')).toContainText('Renamed in the template.', { timeout: o.live ? 10_000 : 15_000 });
  expect(etags.length).toBeGreaterThan(0);   // polling asks with If-None-Match (304 while nothing changed)
  expect(await page.evaluate(() => (window as { clicked?: number }).clicked ?? 0)).toBe(0);
}
