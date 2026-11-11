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
  handle: { api: { isOpen(): boolean; close(): void; setMode(m: string): void; notes(): unknown[] }; unmount(): void };
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

test('draggable launcher and toolbar, page buttons open it, launcher can be hidden (D51)', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
    w.handle.unmount();
    document.body.insertAdjacentHTML('beforeend', '<nav><button id="mine" data-drag-open>Review</button> <button id="mine-c" data-drag-open="comment">Comment</button></nav>');
    w.handle = await w.mount({ transport: w.memory, captureErrors: false, hostTag: 'drag-root', namespace: 'drag', config: { draggable: true, launcherSize: 'small' } });
  });
  const ui = (sel: string) => page.locator(`drag-root ${sel}`);
  const box = async (sel: string) => (await ui(sel).boundingBox())!;
  const isOpen = () => page.evaluate(() => (window as unknown as W).handle.api.isOpen());
  const stored = (k: string) => page.evaluate(k => localStorage.getItem(k), k);
  const dragBy = async (sel: string, dx: number, dy: number) => {
    const b = await box(sel);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx / 2, b.y + b.height / 2 + dy / 2, { steps: 3 });
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 3 });
    await page.mouse.up();
  };

  // A small launcher (launcherSize) moves like any other; the press that moved it doesn't open the overlay; a plain click still does.
  const l0 = await box('.launcher');
  expect([l0.width, l0.height]).toEqual([26, 26]);
  await dragBy('.launcher', -300, -200);
  const l1 = await box('.launcher');
  // (within a few px: the hovered launcher is scaled up a little)
  expect(l0.x - l1.x).toBeCloseTo(300, -1);
  expect(l0.y - l1.y).toBeCloseTo(200, -1);
  expect(await isOpen()).toBe(false);
  expect(JSON.parse((await stored('drag:pos:launcher'))!)).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  await ui('.launcher').click();
  expect(await isOpen()).toBe(true);

  // The toolbar moves by its icon, both ways on a wide screen.
  const b0 = await box('.bar');
  await dragBy('.bar .brand', 150, -250);
  const b1 = await box('.bar');
  expect([Math.round(b1.x - b0.x), Math.round(b1.y - b0.y)]).toEqual([150, -250]);
  // Dragging a button instead does nothing.
  await dragBy('.bar button >> nth=0', 0, -100);
  expect(Math.round((await box('.bar')).y)).toBe(Math.round(b1.y));
  // The sketch tools have their own handle and place; dragging them draws nothing.
  await page.keyboard.press('s');
  const t0 = await box('.tools');
  await dragBy('.tools .brand', -200, 300);
  const t1 = await box('.tools');
  expect([Math.round(t1.x - t0.x), Math.round(t1.y - t0.y)]).toEqual([-200, 300]);
  await expect(ui('.tools button').filter({ hasText: 'Undo' })).toBeDisabled();   // no stroke
  await page.keyboard.press('Escape');
  await page.keyboard.press('s');
  expect(Math.round((await box('.tools')).y)).toBe(Math.round(t1.y));   // remembered
  // Double-clicking an icon puts them all back.
  await ui('.tools .brand').dblclick();
  expect(Math.round((await box('.tools')).y)).toBe(Math.round(t0.y));
  await page.keyboard.press('Escape');
  expect(Math.round((await box('.bar')).y)).toBe(Math.round(b0.y));
  expect(await stored('drag:pos:launcher')).toBe('null');

  // Phone width: the toolbar spans the screen, so it only moves up and down.
  await page.setViewportSize({ width: 390, height: 760 });
  const p0 = await box('.bar');
  await dragBy('.bar .brand', 120, -300);
  const p1 = await box('.bar');
  expect([Math.round(p1.x - p0.x), Math.round(p1.y - p0.y)]).toEqual([0, -300]);
  expect(JSON.parse((await stored('drag:pos:bar'))!).x).toBeNull();
  await page.setViewportSize({ width: 1280, height: 720 });

  // A toolbar moved to the top: toasts show right below it, not at the bottom.
  await dragBy('.bar .brand', 0, -700);
  const top = await box('.bar');
  expect(Math.round(top.y)).toBe(4);
  await page.evaluate(() => (window as unknown as W & { handle: { api: { toast(m: string): void } } }).handle.api.toast('Hello'));
  expect(Math.round((await box('.toast')).y)).toBe(Math.round(top.y + top.height + 10));

  // The page's own buttons (data-<namespace>-open): toggle, and pick a mode.
  await page.locator('#mine').click();
  expect(await isOpen()).toBe(false);
  await page.locator('#mine').click();
  expect(await isOpen()).toBe(true);
  await page.locator('#mine-c').click();
  await expect(ui('.bar button.on')).toContainText('Comment');
  // While picking, the page's button still works (and isn't picked as a note target).
  await page.locator('#mine').click();
  expect(await isOpen()).toBe(false);
  await expect(ui('.pop')).toHaveCount(0);

  // The gate (sign-in) opens next to the moved toolbar too.
  await page.evaluate(() => (window as unknown as Record<string, any>).handle.api.gate((el: HTMLElement) => { el.innerHTML = '<p>Sign in</p>'; return new Promise(() => {}); }));   // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.locator('#mine').click();
  await expect(ui('.gate')).toBeVisible();
  const bar = await box('.bar');
  expect(Math.round((await box('.gate')).y)).toBe(Math.round(bar.y + bar.height + 10));

  // launcher: false hides the button; the page's button still opens the overlay.
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
    w.handle.api.close();   // (the open state is kept per tab, and the toggle below should open)
    w.handle.unmount();
    w.handle = await w.mount({ transport: w.memory, captureErrors: false, hostTag: 'drag-root', namespace: 'drag', config: { launcher: false, draggable: false } });
  });
  await expect(ui('.launcher')).toBeHidden();
  await page.locator('#mine').click();
  expect(await isOpen()).toBe(true);
  await expect(ui('.bar .brand')).not.toHaveClass(/grab/);   // draggable: false pins them (on by default since 0.10)
});

test('launcherPosition: a side or the middle on each axis, px from the edge; a dragged launcher resets to it', async ({ page }) => {
  const mountAt = (launcherPosition: unknown) => page.evaluate(async pos => {
    const w = window as unknown as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
    w.handle.unmount();
    w.handle = await w.mount({ transport: w.memory, captureErrors: false, hostTag: 'pos-root', namespace: 'pos', config: { draggable: true, launcherPosition: pos } });
    w.handle.api.close();   // the page may have left it open
  }, launcherPosition);
  const box = async () => (await page.locator('pos-root .launcher').boundingBox())!;
  const vp = page.viewportSize()!;
  await mountAt('top-left 24');
  expect(await box()).toMatchObject({ x: 24, y: 24, width: 32 });
  await mountAt('bottom-center 16 80');
  let b = await box();
  expect(Math.round(b.x + b.width / 2)).toBe(Math.round(vp.width / 2));
  expect(Math.round(vp.height - b.y - b.height)).toBe(80);
  await mountAt({ x: 'right', y: 'middle', offsetX: 40 });
  b = await box();
  expect(Math.round(vp.width - b.x - b.width)).toBe(40);
  expect(Math.round(b.y + b.height / 2)).toBe(Math.round(vp.height / 2));
  // Dragged, it stays where the reviewer put it.
  await page.mouse.move(b.x + 16, b.y + 16);
  await page.mouse.down();
  await page.mouse.move(b.x - 200, b.y - 100, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await box()).x)).toBeLessThan(Math.round(b.x) - 150);
  // Double-clicking the toolbar's icon puts it back on the configured spot.
  await page.locator('pos-root .launcher').click();
  await page.locator('pos-root .bar .brand').dblclick();
  await page.evaluate(() => (window as unknown as W).handle.api.close());
  await expect.poll(async () => Math.round(vp.width - (await box()).x - 32)).toBe(40);
  await page.evaluate(() => localStorage.clear());
});

test('API v4: error and change events, beforeSave, card decorators and actions, pin style, an extension mode and sketch tool (D52)', async ({ page }) => {
  await page.evaluate(async () => {
    const w = window as unknown as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
    w.handle.unmount();
    const at = new Date().toISOString();
    const notes: Record<string, unknown>[] = [
      { id: 'n1', type: 'comment', page: '/', url: location.href, at, body: 'Heading', reply: '', done: false, meta: { number: 7 }, target: { tag: 'h1', selector: 'h1' } },
      { id: 'n2', type: 'comment', page: '/', url: location.href, at, body: 'Second', reply: '', done: false, target: { tag: 'p', selector: '#clicks' } },
    ];
    let rev = 0;
    w.fail = ''; w.events = []; w.created = []; w.acted = []; w.picks = [];
    const transport = {
      ...w.memory,
      load: async () => { if (w.fail) throw new Error(w.fail); return { version: String(rev), root: 'memory', notes: structuredClone(notes) }; },
      create: async (req: { note: Record<string, unknown> }) => { w.created.push(req); const n = { ...req.note, id: 'n' + (notes.length + 1), at, reply: '', done: false }; notes.push(n); rev++; return n; },
      update: async (id: string, p: object) => { Object.assign(notes.find(n => n.id === id)!, p); rev++; return {}; },
      remove: async (id: string) => { notes.splice(notes.findIndex(n => n.id === id), 1); rev++; return {}; },
      message: async (id: string, body: string) => { const n = notes.find(x => x.id === id)!; n.messages = [...((n.messages as unknown[]) ?? []), { body }]; rev++; return {}; },
    };
    w.handle = await w.mount({ transport, captureErrors: false, hostTag: 'v4-root', namespace: 'v4' });
    const rl = w.handle.api;
    for (const e of ['error', 'noteUpdated', 'noteRemoved', 'messageSent'])
      rl.on(e, (x: Record<string, unknown>) => w.events.push([e, e === 'error' ? { op: x.op, message: (x.error as Error).message } : x]));
    rl.beforeSave((req: { note: Record<string, unknown> }) => req.note.body === 'nope' ? false : { ...req, note: { ...req.note, meta: { ticket: 'T-1' } } });
    rl.addCardDecorator({ id: 'num', render: (n: { meta?: { number?: number } }, el: HTMLElement) => { if (n.meta?.number) el.textContent = `#${n.meta.number}`; } });
    rl.addCardAction({ id: 'copy', label: '⎘', title: 'Copy id', show: (n: { id: string }) => n.id === 'n1', onClick: (n: { id: string }) => w.acted.push(n.id) });
    rl.setPinStyle((n: { id: string }) => n.id === 'n1' ? { label: 'A', color: 'rgb(0, 0, 255)' } : null);
    rl.addMode({ id: 'measure', label: 'Measure', key: 'm', onPick: (p: { el: Element | null; whole: boolean }) => w.picks.push([p.el?.tagName ?? null, p.whole]) });
    rl.addSketchTool({ id: 'oval', label: 'Oval', svg: (b: { x1: number; y1: number; x2: number; y2: number }, c: string) =>
      `<ellipse cx="${(b.x1 + b.x2) / 2}" cy="${(b.y1 + b.y2) / 2}" rx="${Math.abs(b.x2 - b.x1) / 2}" ry="${Math.abs(b.y2 - b.y1) / 2}" stroke="${c}" stroke-width="3"/>` });
    w.rl = rl;
  });
  // Runs `fn` in the page with the window (as a loose record) as its argument.
  const w = <T,>(fn: (w: Record<string, any>) => T) => page.evaluate(`(${fn.toString()})(window)`) as Promise<T>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  const ui = (sel: string) => page.locator(`v4-root ${sel}`);
  expect(await w(x => x.rl.version)).toBe(6);

  // error: once per failure streak (polling goes on quietly), and again only after a success.
  await w(x => { x.fail = 'Unauthorized'; });
  await w(x => x.rl.refresh());
  await w(x => x.rl.refresh());
  expect(await w(x => x.events)).toEqual([['error', { op: 'load', message: 'Unauthorized' }]]);
  await w(x => { x.fail = ''; x.events.length = 0; });
  await w(x => x.rl.refresh());

  // Pin style: the extension's label and colour on n1; n2 keeps its number.
  await expect(ui('.pin').filter({ hasText: 'A' })).toHaveCSS('background-color', 'rgb(0, 0, 255)');
  await expect(ui('.pin').filter({ hasText: '2' })).toHaveCount(1);

  // Cards: the decorator's chip and the action (only where show() says so); then the change events.
  await page.keyboard.press('Alt+Shift+E');
  await page.keyboard.press('n');
  const c1 = ui('.card[data-id="n1"]'), c2 = ui('.card[data-id="n2"]');
  await expect(c1.locator('.ext-card[data-ext="num"]')).toHaveText('#7');
  await expect(c2.locator('.ext-card')).toHaveCount(0);   // rendered nothing: no empty box
  await expect(c2.locator('[data-ext="copy"]')).toHaveCount(0);
  await c1.locator('[data-ext="copy"]').click();
  expect(await w(x => x.acted)).toEqual(['n1']);
  await c1.locator('textarea.reply-box').fill('Looks good');
  await c1.getByRole('button', { name: 'Send' }).click();
  await expect(c1.locator('.msg')).toContainText('Looks good');
  await c1.getByTitle('Mark done').click();
  await c2.getByTitle('Delete').click();
  await c2.getByTitle('Delete').click();
  await expect.poll(() => w(x => x.events)).toEqual([
    ['messageSent', { id: 'n1', body: 'Looks good' }],
    ['noteUpdated', { id: 'n1', patch: { done: true } }],
    ['noteRemoved', { id: 'n2' }],
  ]);
  await page.keyboard.press('n');

  // beforeSave: false keeps the draft open and saves nothing; otherwise its change is what's saved.
  await page.keyboard.press('c');
  await page.locator('#app-btn').click();
  await expect(ui('.pop textarea')).toBeFocused();
  await page.keyboard.type('nope');
  await page.keyboard.press('Control+Enter');
  await expect(ui('.pop textarea')).toBeVisible();
  expect(await w(x => x.created.length)).toBe(0);
  await ui('.pop textarea').fill('Fine');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => w(x => x.created.map((r: { note: { body: string; meta?: unknown } }) => [r.note.body, r.note.meta]))).toEqual([['Fine', { ticket: 'T-1' }]]);

  // An extension mode: its button and key, a pick the app never sees, then back to idle.
  await page.keyboard.press('m');
  await expect(ui('.bar [data-mode="measure"]')).toHaveClass(/on/);
  await page.locator('#app-btn').click();
  expect(await w(x => x.picks)).toEqual([['BUTTON', false]]);
  await expect(page.locator('#clicks')).toHaveText('0');
  await expect(ui('.bar [data-mode="measure"]')).not.toHaveClass(/on/);

  // An extension sketch tool on key 5: its shape is drawn by its svg() and kept in the sketch.
  await page.keyboard.press('s');
  const oval = ui('.tools button').filter({ hasText: 'Oval' });
  await expect(oval).toContainText('5');
  await page.keyboard.press('5');
  await expect(oval).toHaveClass(/on/);
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(420, 380, { steps: 4 });
  await page.mouse.up();
  await expect(ui('svg.rl-sketch ellipse')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // v5 (D53): a window (rendered on first show, kept up while the overlay is closed), live indicators, the launcher bubble.
  await w(x => {
    x.rl.open();
    x.statusEvents = [];
    x.rl.on('status', (e: unknown) => x.statusEvents.push(e));
    x.win = x.rl.addWindow({ id: 'log', title: 'Log', width: 300, height: 200, render: (body: HTMLElement, controls: HTMLElement) => {
      body.textContent = 'log body'; controls.append(Object.assign(document.createElement('button'), { textContent: 'Clear' }));
    } });
    x.rl.setStatus('job', { color: 'rgb(79, 140, 255)', title: 'job: busy', spin: true, onClick: () => x.win.show() });
    x.rl.setStatus('ping', { color: 'rgb(255, 159, 10)', title: 'ping: waiting', pulse: true, launcher: 'ring', toolbar: 'outline' });
  });
  await expect(ui('.win[data-win="log"]')).toBeHidden();
  await expect(ui('.bar .dots [data-status="job"]')).toHaveAttribute('title', 'job: busy');      // no button named: after the brand
  await expect(ui('.bar.lit.pulse[data-status="ping"]')).toHaveAttribute('title', 'ping: waiting');   // the toolbar's outline
  await expect(ui('.bar .dots [data-status="ping"]')).toHaveCount(0);
  await ui('.bar .dots [data-status="job"]').click();
  await expect(ui('.win[data-win="log"] .win-body')).toHaveText('log body');
  await expect(ui('.win[data-win="log"] .win-controls button')).toHaveText('Clear');
  await w(x => x.rl.close());
  await expect(ui('.launcher .ring[data-status="ping"]')).toHaveCSS('border-top-color', 'rgb(255, 159, 10)');   // the ring status
  await expect(ui('.launcher .dots .dot[data-status="job"]')).toBeVisible();                                   // the others as dots
  await expect(ui('.launcher .badge')).toHaveText('1');   // default bubble: open notes on the page
  await w(x => x.rl.setBadge((open: number) => (open ? `${open}!` : null)));
  await expect(ui('.launcher .badge')).toHaveText('1!');
  await w(x => x.rl.setBadge(false));
  await expect(ui('.launcher .badge')).toHaveCount(0);
  await expect(ui('.win[data-win="log"]')).toBeVisible();
  await ui('.win[data-win="log"] .win-close').click();
  await expect(ui('.win[data-win="log"]')).toBeHidden();
  await w(x => { x.rl.setStatus('job', null); x.rl.setStatus('ping', null); });
  await expect(ui('.launcher .ring, .launcher .dot')).toHaveCount(0);
  expect(await w(x => x.statusEvents.map((e: { id: string; status: { title?: string } | null }) => [e.id, e.status?.title ?? null])))
    .toEqual([['job', 'job: busy'], ['ping', 'ping: waiting'], ['job', null], ['ping', null]]);

  // v5: an extension toolbar in place of the main one; its hotkey from anywhere, ← and Esc go back, ✕ closes, a mode leaves it.
  await w(x => {
    x.tbLog = [];
    x.tb = x.rl.addToolbar({
      id: 'deck', hotkey: 'alt+shift+d',
      render: (el: HTMLElement) => { el.append(Object.assign(document.createElement('button'), { textContent: `Next ${x.tbLog.length}` })); },
      attached: (el: HTMLElement) => { if (x.cardText) el.textContent = x.cardText; },
      onShow: () => x.tbLog.push('show'), onHide: () => x.tbLog.push('hide'),
    });
  });
  await expect(ui('.bar')).toBeHidden();   // added hidden, overlay still closed
  await page.keyboard.press('Alt+Shift+KeyD');
  await expect(ui('.bar.ext .xbar[data-toolbar="deck"] button')).toHaveText('Next 1');
  // Its attached card: none while empty; above the toolbar (which sits low).
  await expect(ui('.attach')).toBeHidden();
  await w(x => { x.cardText = 'Speaker notes'; x.tb.render(); });
  await expect(ui('.attach[data-toolbar="deck"]')).toHaveText('Speaker notes');
  const [cardBox, barBox] = [await ui('.attach').boundingBox(), await ui('.bar').boundingBox()];
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(barBox!.y);
  await expect(ui('.bar button').filter({ hasText: 'Comment' })).toHaveCount(0);
  expect(await w(x => x.tb.isOpen())).toBe(true);
  await ui('.bar button.back').click();
  await expect(ui('.bar button').filter({ hasText: 'Comment' })).toBeVisible();
  await expect(ui('.attach')).toBeHidden();   // the card goes with its toolbar
  await w(x => x.tb.show());
  await page.keyboard.press('Escape');
  await expect(ui('.bar.ext')).toHaveCount(0);
  // ✕ closes the overlay, as on the main toolbar (it used to go back); opened again, it's the main toolbar.
  await w(x => x.tb.show());
  await ui('.bar.ext button.close').click();
  await expect(ui('.bar')).toBeHidden();
  await ui('.launcher').click();
  await expect(ui('.bar button').filter({ hasText: 'Comment' })).toBeVisible();
  await w(x => x.tb.show());
  await page.keyboard.press('c');   // a mode: the main toolbar, with Comment on
  await expect(ui('.bar button.on')).toHaveText(/Comment/);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+Shift+KeyD');
  await page.keyboard.press('Alt+Shift+KeyD');   // pressed in it: closes the overlay
  await expect(ui('.bar')).toBeHidden();
  expect(await w(x => x.tbLog)).toEqual(['show', 'hide', 'show', 'hide', 'show', 'hide', 'show', 'hide', 'show', 'hide']);
  await w(x => x.tb.remove());
  await page.keyboard.press('Alt+Shift+KeyD');
  await expect(ui('.bar')).toBeHidden();   // removed: its hotkey is gone

  // D62: a `title` makes the back button "← Deck" (the icon alone, no "Redline"); `onEscape` handles Esc
  // first (true: kept, its own popover closed); `hideAs: 'minimize'` draws the window's hide as —.
  await w(x => {
    x.escapes = 0;
    x.tb = x.rl.addToolbar({ id: 'deck', title: 'Deck', render: (el: HTMLElement) => { el.textContent = 'slides'; }, onEscape: () => ++x.escapes === 1 });
    x.tb.show();
    x.rl.addWindow({ id: 'run', title: 'Run', hideAs: 'minimize', render: (body: HTMLElement) => { body.textContent = 'running'; } }).show();
  });
  await expect(ui('.bar.ext button.back')).toHaveText(/^←\s*Deck$/);
  await expect(ui('.bar.ext button.back')).toHaveAttribute('aria-label', /^Deck: Back/);
  await expect(ui('.bar.ext .brand')).toHaveText('');
  await page.keyboard.press('Escape');   // onEscape said it handled it
  await expect(ui('.bar.ext')).toBeVisible();
  await page.keyboard.press('Escape');   // now it didn't: back to the main toolbar
  await expect(ui('.bar.ext')).toHaveCount(0);
  await expect(ui('.bar .brand')).toHaveText('Redline');
  const min = ui('.win[data-win="run"] .win-close');
  await expect(min).toHaveText('—');
  await expect(min).toHaveAttribute('title', 'Minimize');
  await min.click();
  await expect(ui('.win[data-win="run"]')).toBeHidden();
});
