// Regenerates the README screenshots (docs/images/*.png) from the demo app in examples/demo, and the hub's UI.
//   npm run screenshots        (builds dist/ first)
// Starts the demo on its own Vite server, drives the overlay with Playwright, then stops it; then a throwaway hub
// (its own temp database) with a project and a few notes for hub.png.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { createServer } from 'vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const demo = path.resolve('examples/demo');
const out = path.resolve('docs/images');
// Own notes folder (inside the gitignored .redline), so a demo running by hand keeps its notes; the agent toolbar
// runs the tests' stand-in CLI (test/fixtures/agent), so the shot doesn't depend on an installed agent.
process.env.REDLINE_DIR = '.redline/screens';
process.env.REDLINE_AGENT = 'fake';
const notesDir = path.join(demo, process.env.REDLINE_DIR);
const notesFile = path.join(notesDir, 'pages/index.md');

await fs.rm(notesDir, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

const server = await createServer({ configFile: path.join(demo, 'vite.config.mjs'), server: { port: 5210, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM ? undefined : 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 700 }, deviceScaleFactor: 2 });
const ui = sel => page.locator('redline-root').locator(sel);
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const saved = () => page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST');
const centre = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
// Hover first, then click: the overlay picks the hovered element on pointerup.
const pick = async loc => { const [x, y] = await centre(loc); await page.mouse.move(x, y); await page.mouse.click(x, y); };
// Save with `key`, wait for the POST, and let the "Saved" toast clear before the next shot.
// The popover focuses its textarea a tick after it appears; typing earlier would hit the mode keys.
const typeNote = async text => {
  await page.waitForFunction(() => document.querySelector('redline-root')?.shadowRoot?.activeElement?.tagName === 'TEXTAREA');
  await page.keyboard.type(text);
};
const save = async key => { const r = saved(); await page.keyboard.press(key); await r; await ui('.toast').waitFor({ state: 'hidden' }); };

try {
  await page.goto('http://localhost:5210/', { waitUntil: 'networkidle' });
  await ui('.launcher').waitFor({ state: 'attached' });
  await page.keyboard.press('Alt+Shift+KeyR');
  await ui('.bar').waitFor();

  // 1. Comment on the primary button.
  await page.keyboard.press('c');
  await pick(page.getByTestId('new-route'));
  await ui('.pop .chip').filter({ hasText: 'UX' }).click();   // a label (D46)
  await typeNote('Make this the only purple button on the page, and add a "+" icon.');
  await shot('comment');
  await save('Control+Enter');

  // 2. Rewrite the lead text in place.
  await page.keyboard.press('t');
  await pick(page.locator('p.lead'));
  await ui('.ed').waitFor();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Every route, every driver, live. Updated every 30 seconds.');
  await page.keyboard.press('Enter');
  await ui('.pop .diff').waitFor();
  await ui('.pop .chip').filter({ hasText: 'Copy' }).click();
  await shot('text');
  await save('Enter');

  // 3. Sketch: a box around the chart, an arrow and a label. Shot before the note popover covers it.
  await page.keyboard.press('s');
  const chart = await page.locator('.chart').boundingBox();
  await page.keyboard.press('1');
  await drag([chart.x - 6, chart.y - 6], [chart.x + chart.width + 6, chart.y + chart.height + 6]);
  await page.keyboard.press('2');
  await drag([chart.x - 150, chart.y + chart.height + 40], [chart.x - 12, chart.y + chart.height - 40]);
  await page.keyboard.press('4');
  await page.mouse.click(chart.x - 330, chart.y + chart.height + 62);
  await page.waitForFunction(() => document.querySelector('redline-root')?.shadowRoot?.activeElement?.tagName === 'INPUT');
  await page.keyboard.type('line chart + last week?');
  await page.keyboard.press('Enter');
  await page.mouse.move(chart.x + chart.width / 2, chart.y + 60);
  await shot('sketch');
  await page.keyboard.press('Enter');
  await typeNote('#idea Switch this to a line chart with last week as a dashed comparison.');
  await save('Control+Enter');

  // 4. An agent ticks the first note off and replies, then the panel shows it live.
  const md = await fs.readFile(notesFile, 'utf8');
  await fs.writeFile(notesFile, md.replace(/^### \[ \]/m, '### [x]')
    .replace('add a "+" icon.\n', 'add a "+" icon.\n\n> Done: Export CSV is now a ghost button and New route has a plus icon (src/App.tsx:32).\n'));
  await page.keyboard.press('n');
  await ui('.filters label').filter({ hasText: 'Show done' }).click();
  await ui('.card .reply').waitFor();
  await shot('panel');

  // 5. The agent toolbar (D53): the CLI asks to edit a file; the card shows its diff and options.
  await page.keyboard.press('n');   // close the panel
  await page.keyboard.press('Alt+Shift+KeyA');
  const bar = ui('.xbar[data-toolbar="agent"]');
  await bar.waitFor();
  const info = await (await page.request.get('http://localhost:5210/__redline/agent/info')).json();
  await page.request.post('http://localhost:5210/__redline/agent/send', {
    headers: { 'x-agent-token': info.token }, data: { text: 'ask' } });   // the stand-in's edit permission
  await ui('.attach[data-toolbar="agent"] button').first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);   // the status light settles
  await shot('agent');
  const agentApi = (p, data) => page.request.post(`http://localhost:5210/__redline/agent${p}`, { headers: { 'x-agent-token': info.token }, data });
  await agentApi('/end', {});

  // 6. The agent toolbar's settings (⚙, D62, D64): CLI, model, effort, sessions, worktrees.
  await agentApi('/mode', { mode: 'fresh' });
  await bar.locator('button.ag-gear').click();
  await ui('.attach[data-toolbar="agent"] .ag-set').waitFor();
  await page.waitForTimeout(300);
  await shot('agent-settings');
  await bar.locator('button.ag-gear').click();

  // 7. Attachments (D56): a session in its own worktree (D64) writes an image and prints a link; its 📎 card,
  // the changed file's diff open. The worktree and its branch are discarded after.
  await agentApi('/worktrees', { on: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="88"><rect width="240" height="88" rx="16" fill="#7c3aed"/><text x="120" y="56" font-size="28" text-anchor="middle" fill="#fff" font-family="Segoe UI, sans-serif">+ Plan a route</text></svg>';
  const { id } = await (await agentApi('/send', { text: `write src/plan-route-button.svg ${svg}<!-- link -->`, title: 'Purple button', task: 'Apply notes' })).json();
  const clip = bar.locator(`.ag-tab[data-id="${id}"] button.ag-att`);
  await clip.waitFor({ timeout: 30_000 });
  await bar.locator('.ag-chip').filter({ hasText: 'Done' }).waitFor({ timeout: 30_000 });
  await clip.click();
  const files = ui('.attach[data-toolbar="agent"] .ag-files');
  await files.locator('button.ag-frow').first().click();
  await files.locator('pre.ag-diff').waitFor();
  await files.locator('.ag-thumb img').evaluate(img => img.complete || new Promise(r => { img.onload = r; }));
  await page.mouse.move(10, 10);
  await page.waitForTimeout(400);
  await shot('agent-files');
  await agentApi('/end', {});
  for (let t = 0; t < 50; t++) {
    const left = (await (await page.request.get('http://localhost:5210/__redline/agent/info')).json()).worktrees.left;
    if (left.length) { for (const w of left) await agentApi('/worktree', { branch: w.branch, action: 'discard', confirm: true }); break; }
    await page.waitForTimeout(100);
  }
  await agentApi('/worktrees', { on: false });
  await agentApi('/mode', { mode: 'shared' });

  // 8. The hub's web UI (D44): a project with notes from two reviewers, one resolved by an agent.
  await hubShot();
  console.log(`Wrote ${['comment', 'text', 'sketch', 'panel', 'agent', 'agent-settings', 'agent-files', 'hub'].map(n => `docs/images/${n}.png`).join(', ')}`);
} finally {
  await browser.close();
  await server.close();
}

async function hubShot() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-hub-shot-'));
  const child = spawn(process.execPath, ['hub/dist/cli.js', '--port', '0', '--db', path.join(tmp, 'hub.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let log = '';
    child.stdout.on('data', d => { log += d; });
    for (let t = 0; t < 150 && !/Sign in:\s+\S+#key=\S+/.test(log); t++) await new Promise(r => setTimeout(r, 100));
    const [, url, key] = /Sign in:\s+(\S+)\/#key=(\S+)/.exec(log);
    const login = await fetch(url + '/api/login', { method: 'POST', headers: { 'x-redline-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = (method, p, body) => fetch(url + '/api' + p, { method, headers: { cookie, 'x-redline-hub': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    const project = await api('POST', '/projects', { name: 'Customer portal', sites: 'http://localhost:5210' });
    const token = async person => (await api('POST', `/projects/${project.slug}/tokens`, { person })).token;
    const as = async (person, note, shotName) => {
      const screenshot = shotName ? 'data:image/png;base64,' + (await fs.readFile(path.join(out, `${shotName}.png`))).toString('base64') : undefined;
      const r = await fetch(`${project.store}/notes`, { method: 'POST', headers: { authorization: `Bearer ${await token(person)}`, 'content-type': 'application/json' }, body: JSON.stringify({ note: { type: 'comment', url: 'http://localhost:5210/', ...note }, ...(screenshot ? { screenshot } : {}) }) });
      return r.json();
    };
    const first = await as('alice@example.com', { page: '/', body: 'Make this the only purple button on the page, and add a "+" icon.', label: 'UX' }, 'comment');
    await as('bob@example.com', { page: '/', body: 'Switch this to a line chart with last week as a dashed comparison.', label: 'Idea' }, 'sketch');
    await as('alice@example.com', { page: '/settings', body: 'The save button jumps when the form validates.', label: 'Bug' });
    await api('PATCH', `/projects/${project.slug}/notes/${first.id}`, { done: true, reply: 'Done: New route is the purple primary with a plus icon (src/App.tsx:32).' });
    const hub = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await hub.goto(`${url}/#key=${key}`);
    await hub.goto(`${url}/#/p/${project.slug}`);
    await hub.locator('.note, .card').first().waitFor();
    await hub.waitForTimeout(500);
    await hub.screenshot({ path: path.join(out, 'hub.png') });
    await hub.close();
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 300));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

async function drag([x1, y1], [x2, y2]) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up();
}
