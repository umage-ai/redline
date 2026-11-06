// Embedding (D49): mount() from dist/overlay on a page with no dev server, with its own
// transport, a closed shadow root, its own host tag and namespace; unmount() leaves nothing behind.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'http://embed.test';
const PAGE = `<!doctype html><html><body>
<h1>Embedded</h1><button id="app-btn">App button</button><p id="clicks">0</p>
<script>document.getElementById('app-btn').addEventListener('click', () => { const c = document.getElementById('clicks'); c.textContent = String(+c.textContent + 1); });</script>
<script type="module">
  import { mount, httpTransport } from '/overlay/mount.js';
  const notes = [];
  window.created = [];
  window.shots = [];
  window.origError = console.error;
  window.memory = {
    config: async () => ({ hotkey: 'alt+shift+e', launcher: true, dir: 'memory' }),
    load: async () => ({ version: String(notes.length), root: 'memory', notes: notes.slice() }),
    create: async req => {
      window.created.push(req);
      const n = { ...req.note, id: 'n' + notes.length, at: new Date().toISOString(), reply: '', done: false };
      notes.push(n);
      return { ...n, file: 'memory/notes' };
    },
    update: async () => ({}), remove: async () => ({}), assetUrl: rel => rel,
  };
  window.mount = mount;
  window.httpTransport = httpTransport;
  window.handle = await mount({
    transport: window.memory, shadowMode: 'closed', hostTag: 'att-root', namespace: 'att', captureErrors: false,
    theme: { '--ink': '#0a84ff' },
    screenshot: async (req, next) => { window.shots.push(req.host.localName); return undefined; },
  });
  window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
    if (url.pathname.startsWith('/overlay/')) {
      const file = path.join('dist', url.pathname);
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(file, 'utf8').catch(() => '') });
    }
    return route.fulfill({ status: 404, body: 'not here' });
  });
  await page.goto(ORIGIN + '/');
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
});

type W = Window & {
  handle: { api: { isOpen(): boolean; setMode(m: string): void; notes(): unknown[] }; unmount(): void };
  created: { note: { body: string; errors?: string[] } }[]; shots: string[]; origError: unknown;
  mount(o?: object): Promise<{ unmount(): void }>;
};

test('mount(): own transport, closed shadow root, own tag, namespace and theme', async ({ page }) => {
  const host = await page.evaluate(() => {
    const h = document.querySelector('att-root') as HTMLElement;
    return { closed: !!h && h.shadowRoot === null, builtIn: !!document.querySelector('redline-root'), ink: getComputedStyle(h).getPropertyValue('--ink').trim() };
  });
  expect(host).toEqual({ closed: true, builtIn: false, ink: '#0a84ff' });

  await page.keyboard.press('Alt+Shift+E');
  expect(await page.evaluate(() => (window as unknown as W).handle.api.isOpen())).toBe(true);
  expect(await page.evaluate(() => [sessionStorage.getItem('att:state') !== null, sessionStorage.getItem('redline:state')])).toEqual([true, null]);

  // A comment through the closed shadow root: the popover's textarea has focus, so the keyboard reaches it.
  await page.keyboard.press('c');
  await page.locator('#app-btn').click();
  await expect(page.locator('#clicks')).toHaveText('0');   // the pick never reached the app
  await page.waitForFunction(() => document.activeElement?.localName === 'att-root');
  await page.keyboard.type('Embedded note');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).created.length)).toBe(1);
  const req = await page.evaluate(() => (window as unknown as W).created[0].note);
  expect(req.body).toBe('Embedded note');
  expect(req.errors).toBeUndefined();   // captureErrors: false
  expect(await page.evaluate(() => (window as unknown as W).shots)).toEqual(['att-root']);   // the screenshot hook got the host
  await expect.poll(() => page.evaluate(() => (window as unknown as W).handle.api.notes().length)).toBe(1);

  // A sketch: the drawing surface's pointer events are re-sent inside the closed root too.
  await page.keyboard.press('s');
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(420, 380, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  // The popover's textarea has focus (seen from outside a closed root: the host is active).
  await page.waitForFunction(() => document.activeElement?.localName === 'att-root');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).created.length)).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { created: { sketch?: string }[] }).created[1].sketch)).toContain('M300 300h120v80h-120Z');   // the box as drawn
});

test('unmount(): host, listeners and error capture are gone; mounting again works', async ({ page }) => {
  await page.evaluate(() => (window as unknown as W).handle.api.setMode('comment'));
  await page.evaluate(() => (window as unknown as W).handle.unmount());
  expect(await page.evaluate(() => !!document.querySelector('att-root'))).toBe(false);
  // Comment mode was on: after unmount a click reaches the app again, and the hotkey does nothing.
  await page.locator('#app-btn').click();
  await expect(page.locator('#clicks')).toHaveText('1');
  await page.keyboard.press('Alt+Shift+E');
  expect(await page.evaluate(() => !!document.querySelector('att-root'))).toBe(false);

  // Defaults this time: the dev server's transport (absent here, so default config) and error capture.
  const patched = await page.evaluate(async () => {
    const w = window as unknown as W;
    const h = await w.mount();
    const during = console.error !== w.origError;
    h.unmount();
    return { during, after: console.error !== w.origError, host: !!document.querySelector('redline-root') };
  });
  expect(patched).toEqual({ during: true, after: false, host: false });
});

test('gate, toolbar slot, statuses, thread and strings (D50)', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
    w.handle.unmount();
    let rev = 0;
    const notes = [{ id: 'n1', type: 'comment', page: '/', url: location.href, at: new Date().toISOString(), body: 'First', reply: '', done: false,
      status: 'open', messages: [{ body: 'Can you check mobile?', author: 'Ann', kind: 'owner' }], target: { tag: 'h1', selector: 'h1' } }];
    w.loads = 0; w.patches = []; w.sent = [];
    const transport = {
      ...w.memory,
      load: async () => { w.loads++; return { version: String(rev), root: 'memory', notes: structuredClone(notes) }; },
      update: async (id: string, p: object) => { w.patches.push(p); Object.assign(notes.find(n => n.id === id)!, p); rev++; return {}; },
      message: async (id: string, body: string) => { w.sent.push(body); notes.find(n => n.id === id)!.messages.push({ body, author: 'Me', kind: 'reviewer' }); rev++; return {}; },
    };
    w.handle = await w.mount({
      transport, captureErrors: false, hostTag: 'gate-root',
      strings: { comment: 'Kommentar', notes: 'Noter' },
      config: { statuses: [{ id: 'open', label: 'Open' }, { id: 'review', label: 'In review', color: '#ffb020' }, { id: 'fixed', label: 'Fixed', done: true }] },
      gate: (el: HTMLElement) => new Promise<void>(res => {
        const b = document.createElement('button');
        b.id = 'signin'; b.textContent = 'Sign in'; b.onclick = () => res();
        el.append(b);
      }),
    });
    w.handle.api.addSlot({ id: 'ws', render: (el: HTMLElement) => { el.textContent = 'Workspace A'; } });
  });
  // Runs `fn` in the page with the window (as a loose record) as its argument.
  const w = <T,>(fn: (w: Record<string, any>) => T) => page.evaluate(`(${fn.toString()})(window)`) as Promise<T>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  const bar = page.locator('gate-root .bar');

  // Locked: nothing loads until the gate is passed, and the modes are off.
  expect(await w(x => x.loads)).toBe(0);
  await page.keyboard.press('Alt+Shift+E');
  await expect(page.locator('gate-root .gate #signin')).toBeVisible();
  await expect(bar.getByRole('button', { name: /Kommentar/ })).toBeDisabled();   // translated
  await expect(bar.locator('[data-slot="ws"]')).toHaveText('Workspace A');
  await page.keyboard.press('c');
  await expect(page.locator('gate-root .toast')).toHaveText('Finish the step above first');
  expect(await w(x => x.loads)).toBe(0);

  await page.locator('gate-root #signin').click();
  await expect(page.locator('gate-root .gate')).toBeHidden();
  await expect(bar.getByRole('button', { name: /Kommentar/ })).toBeEnabled();
  expect(await w(x => x.loads)).toBeGreaterThan(0);

  // The panel: the status chip and menu, the thread, and a reply through transport.message.
  await page.keyboard.press('n');
  await expect(page.locator('gate-root .panel h2')).toHaveText('Noter');
  const card = page.locator('gate-root .card[data-id="n1"]');
  await expect(card.locator('.tag.status')).toHaveText('Open');
  await expect(card.locator('.msg.owner')).toContainText('Can you check mobile?');
  await card.locator('textarea.reply-box').fill('On it');
  await card.getByRole('button', { name: 'Send' }).click();
  await expect(card.locator('.msg.reviewer')).toContainText('On it');
  expect(await w(x => x.sent)).toEqual(['On it']);
  await card.locator('select.status-menu').selectOption('fixed');
  await expect.poll(() => w(x => x.patches)).toEqual([{ status: 'fixed', done: true }]);
  await expect(card).toBeHidden();   // a done status hides it while "show done" is off

  // Locked again (sign-out): notes are dropped and the gate is back.
  await w(x => x.handle.api.gate((el: HTMLElement) => { el.innerHTML = '<p id="first">Pick a workspace</p>'; return new Promise(() => {}); }));
  expect(await w(x => [x.handle.api.locked(), x.handle.api.notes().length])).toEqual([true, 0]);
  await expect(page.locator('gate-root .gate #first')).toBeVisible();
  await expect(page.locator('gate-root .panel')).toBeHidden();
  // Locked once more while that step is on screen: the newer gate takes the box over.
  await w(x => x.handle.api.gate((el: HTMLElement) => new Promise<void>(res => {
    const b = document.createElement('button'); b.id = 'second'; b.textContent = 'Continue'; b.onclick = () => res(); el.append(b);
  })));
  await expect(page.locator('gate-root .gate #first')).toHaveCount(0);
  await page.locator('gate-root .gate #second').click();
  await expect(page.locator('gate-root .gate')).toBeHidden();
  await expect.poll(() => w(x => [x.handle.api.locked(), x.handle.api.notes().length])).toEqual([false, 1]);
});
