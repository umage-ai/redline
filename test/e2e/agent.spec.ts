// The agent panel (D53) on the vanilla fixture, with a stand-in CLI (test/fixtures/agent/fake-agent.mjs)
// that reports through OSC 7501 like Claude Code. Every action lives in the agent toolbar (A, or
// alt+shift+a from anywhere): prompt buttons start the CLI without its terminal, Allow/Deny answer
// approvals, "CLI" opens the terminal; the notes panel only shows (a status line, tags on sent notes).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { FIXTURES } from './fixtures.ts';
import { comment, openOverlay, resetNotes, ui } from './helpers.ts';

const f = FIXTURES.vanilla;
test.beforeEach(() => resetNotes(f));
test.afterEach(async ({ request }) => {
  // One set of sessions per dev server: stop them all, close them, back to one shared session.
  const get = async () => (await request.get(`${f.url}/__redline/agent/info`)).json();
  const { token } = await get();
  const post = (p: string, data: object) => request.post(`${f.url}/__redline/agent${p}`, { headers: { 'x-redline': '1', 'x-redline-agent': token }, data });
  await post('/stop', {});
  await expect.poll(async () => (await get()).sessions.filter((x: { running: boolean }) => x.running).length, { timeout: 15_000 }).toBe(0);
  for (const x of (await get()).sessions) await post('/dismiss', { id: x.id });
  await post('/mode', { mode: 'shared' });
});

const NAME = 'node fake-agent.mjs';
const terminal = (page: Page) => page.frameLocator('iframe[title$="terminal"]');
// The state shows as the toolbar's outline (and a ring on the closed launcher); hover text on the bar.
const outline = (page: Page) => ui(page, '.bar.lit[data-status="agent"]');
const agentBar = (page: Page) => ui(page, '.bar.ext .xbar[data-toolbar="agent"]');
const chip = (page: Page) => agentBar(page).locator('.ag-chip');
const win = (page: Page) => ui(page, '.win[data-win="agent"]');

test('agent toolbar: apply notes without the terminal, approve from the toolbar, the panel shows status', async ({ page }) => {
  // The extension must load cleanly, also when the toolbar comes back after a reload (it once hit a TDZ there).
  const failures: string[] = [];
  page.on('console', m => { if (m.text().includes('extension failed')) failures.push(m.text()); });
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await comment(page, page.getByTestId('agent-save'), 'Make this secondary');

  // A opens the agent toolbar in place of the main one: state, the prompt buttons, CLI.
  await page.keyboard.press('a');
  await expect(agentBar(page)).toBeVisible();
  await expect(ui(page, '.bar button[data-ext="agent"]')).toHaveCount(0);   // the main toolbar is swapped out
  await expect(chip(page)).toHaveText(/Not started/);
  const apply = agentBar(page).locator('button[data-cmd="Apply notes"]');
  await expect(apply.locator('.count')).toHaveText('1');
  await expect(win(page)).toBeHidden();

  // Apply: starts the CLI, the prompt names the note, and the terminal stays closed.
  await apply.click();
  await expect(outline(page)).toHaveClass(/spin/, { timeout: 20_000 });
  await expect(chip(page)).toHaveText(/Done/);
  await expect(chip(page)).toContainText("did Apply the open Redline notes");   // the program's message (cut at 40)
  await expect(outline(page)).toHaveCSS('--dot', '#3ecf8e');
  await expect(win(page)).toBeHidden();
  await expect(agentBar(page).locator('.ag-stop')).toBeVisible();

  // The notes panel: a status line (it opens the toolbar) and a tag on the note that was sent.
  await page.keyboard.press('n');
  await expect(agentBar(page)).toBeVisible();   // the panel doesn't swap the toolbar back
  const line = ui(page, '.panel section[data-ext="agent"] .ag-line');
  await expect(line).toContainText(`${NAME}: Done · 1 sent note open`);
  await expect(ui(page, '.card .ag-tag.sent')).toHaveText(`⤳ sent to ${NAME}`);
  await expect(ui(page, '.card button[title^="Send to"]')).toHaveCount(0);   // no actions on the cards
  // The agent ticks the note off in the markdown: the tag says so.
  const md = path.join(f.dir, '.redline/pages/index.md');
  await fs.writeFile(md, (await fs.readFile(md, 'utf8')).replace(/^### \[ \]/m, '### [x]'));
  await ui(page, '.panel label').filter({ hasText: /done/i }).locator('input').check();
  await expect(ui(page, '.card .ag-tag.done')).toHaveText(`✓ done by ${NAME}`, { timeout: 10_000 });
  await expect(line).toContainText('1 done');
  await expect(apply.locator('.count')).toHaveText('0');
  await expect(apply).toBeDisabled();

  // CLI opens the terminal; keys typed there reach the program, never the app.
  await page.evaluate(() => { const w = window as unknown as { appKeys: number }; w.appKeys = 0; addEventListener('keydown', () => w.appKeys++, true); });
  await agentBar(page).locator('button[data-cli]').click();
  await expect(win(page)).toBeVisible();
  await expect(agentBar(page).locator('button[data-cli]')).toHaveClass(/on/);
  await terminal(page).locator('.xterm-screen').click();
  await page.keyboard.type('ask');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as unknown as { appKeys: number }).appKeys)).toBe(0);

  // Waiting for approval: a card attached to the toolbar shows what the CLI asks, read off its screen
  // (the diff in its colours, the question, every option); a click picks one.
  await expect(chip(page)).toHaveText('Needs your approval');   // the question is in the card; the message stays in the hover text
  await expect(chip(page)).toHaveAttribute('title', /Edit src\/App\.tsx\?/);
  await expect(outline(page)).toHaveClass(/pulse/);
  await expect(agentBar(page).getByRole('button', { name: 'Allow' })).toHaveCount(0);   // the card has the real options
  const card = ui(page, '.attach[data-toolbar="agent"] .ag-card');
  await expect(card.locator('.ag-q')).toHaveText('Do you want to make this edit to src/App.tsx?');
  await expect(apply).toBeDisabled();   // nothing new while it asks
  await expect(card.locator('.ag-opt')).toHaveText([/Yes$/, /Yes, and don't ask again this session/, /No$/]);
  await expect(card.locator('.ag-ctx')).toContainText('+  <button>+ Plan a route</button>');
  await expect(card.locator('.ag-ctx span', { hasText: '+  <button>' })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const [cardBox, barBox] = [await card.boundingBox(), await ui(page, '.bar').boundingBox()];
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(barBox!.y);   // the toolbar sits low: the card above it
  await card.locator('.ag-opt', { hasText: "don't ask again" }).click();
  await expect(chip(page)).toHaveText(/Done\s*approved: always/);
  await expect(card).toHaveCount(0);

  // ✕ goes back to the main toolbar; A brings the agent toolbar again.
  await ui(page, '.bar button.back').click();
  await expect(ui(page, '.bar button[data-ext="agent"]')).toBeVisible();
  await expect(outline(page)).toHaveAttribute('title', /done · approved: always/);   // the outline stays on the main toolbar
  await ui(page, '.bar button[data-ext="agent"]').click();
  await expect(agentBar(page)).toBeVisible();

  // A reload keeps the toolbar (and the window); stop brings the terminal's restart screen.
  await page.reload();
  await expect(agentBar(page)).toBeVisible();
  await expect(win(page)).toBeVisible();
  await expect(ui(page, '.panel section[data-ext="agent"] .ag-line')).toContainText('1 done');   // the panel part came up too
  await agentBar(page).locator('.ag-stop').click();
  await expect(terminal(page).getByRole('button', { name: 'Restart' })).toBeVisible();
  await expect(agentBar(page).locator('.ag-stop')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('agent toolbar: its shortcut opens the overlay in it from anywhere, Esc steps back, a mode leaves it', async ({ page }) => {
  await page.goto(f.url, { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await expect(ui(page, '.bar')).toBeHidden();
  await page.keyboard.press('Alt+Shift+KeyA');
  await expect(agentBar(page)).toBeVisible();
  await page.keyboard.press('Alt+Shift+KeyA');   // pressed there: closes the overlay
  await expect(ui(page, '.bar')).toBeHidden();
  await expect(ui(page, '.launcher')).toBeVisible();

  await page.keyboard.press('Alt+Shift+KeyA');
  await expect(agentBar(page)).toBeVisible();
  await page.keyboard.press('Escape');   // back to the main toolbar, overlay still open
  await expect(ui(page, '.bar button[data-ext="agent"]')).toBeVisible();
  await page.keyboard.press('a');
  await expect(agentBar(page)).toBeVisible();
  await page.keyboard.press('c');   // a mode swaps the main toolbar back
  await expect(ui(page, '.bar button.on')).toHaveText(/Comment/);
  await expect(agentBar(page)).toHaveCount(0);
});

test('agent toolbar: stepped questions in the attached card (steps, descriptions, a typed answer, review), below a toolbar moved up', async ({ page, request }) => {
  await openOverlay(page, f);
  await page.keyboard.press('a');
  await expect(agentBar(page)).toBeVisible();
  const info = await (await request.get(`${f.url}/__redline/agent/info`)).json();
  const h = { 'x-redline': '1', 'x-redline-agent': info.token };
  await request.post(`${f.url}/__redline/agent/start`, { headers: h, data: {} });
  await expect(chip(page)).toHaveText(/Ready/, { timeout: 20_000 });
  await request.post(`${f.url}/__redline/agent/input`, { headers: h, data: { data: 'form\r' } });

  const card = ui(page, '.attach[data-toolbar="agent"] .ag-card');
  await expect(chip(page)).toHaveText(/Needs your answer/);
  await expect(card.locator('.ag-steps button:not(.nav)')).toHaveText(['☐ Color', '☐ Size', '✔ Submit']);
  await expect(card.locator('.ag-steps button.cur')).toHaveText('☐ Color');
  await expect(card.locator('.ag-q')).toHaveText('Which colour should the button be?');
  await expect(card.locator('.ag-opt').nth(1)).toContainText('Calm and trustworthy, a common default.');
  await card.locator('.ag-opt', { hasText: 'Blue' }).click();

  // Step 2: an answer of our own, typed into the card.
  await expect(card.locator('.ag-q')).toHaveText('Which size should the button be?');
  await expect(card.locator('.ag-steps button.done')).toHaveText('☒ Color');
  await card.locator('.ag-input input').fill('XL');
  await card.locator('.ag-input input').press('Enter');

  // Review: what was answered, then Submit.
  await expect(card.locator('.ag-q')).toHaveText('Ready to submit your answers?');
  await expect(card.locator('.ag-ctx')).toContainText('→ Blue');
  await expect(card.locator('.ag-ctx')).toContainText('→ XL');

  // The toolbar moved to the top half (as a drag would): the card goes below it.
  await page.evaluate(() => {
    const bar = document.querySelector('redline-root')!.shadowRoot!.querySelector<HTMLElement>('.bar')!;
    Object.assign(bar.style, { top: '24px', bottom: 'auto' });
    dispatchEvent(new Event('resize'));
  });
  const [cardBox, barBox] = [await card.boundingBox(), await ui(page, '.bar').boundingBox()];
  expect(cardBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height);

  await card.locator('.ag-opt', { hasText: 'Submit answers' }).click();
  await expect(chip(page)).toHaveText(/Done\s*answered: Color=Blue, Size=XL/);
  await expect(card).toHaveCount(0);
});

test('agent toolbar: fresh sessions, a tab each; a new question brings its tab up, the card and terminal follow the tab, an ended one closes', async ({ page, request }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await comment(page, page.getByTestId('agent-save'), 'Make this secondary');
  await page.keyboard.press('a');
  const apply = agentBar(page).locator('button[data-cmd="Apply notes"]');
  await expect(apply.locator('.count')).toHaveText('1');

  // Fresh: every prompt starts its own session.
  const mode = agentBar(page).locator('button.ag-mode');
  await mode.click();
  await expect(mode).toHaveClass(/on/);
  await apply.click();
  const tabs = agentBar(page).locator('.ag-tab');
  await expect(tabs).toHaveText(['#1'], { timeout: 20_000 });
  await expect(chip(page)).toHaveText(/Done/, { timeout: 20_000 });
  // While #1 runs, the note is its: a second session wouldn't get it.
  await expect(apply).toBeDisabled();

  // A second session asks: its tab comes up, with the card.
  const { token } = await (await request.get(`${f.url}/__redline/agent/info`)).json();
  const r = await request.post(`${f.url}/__redline/agent/send`, { headers: { 'x-redline': '1', 'x-redline-agent': token }, data: { text: 'ask' } });
  expect((await r.json()).id).toBe('s2');
  await expect(tabs).toHaveText(['#1', '#2']);
  const card = ui(page, '.attach[data-toolbar="agent"] .ag-card');
  await expect(card).toHaveAttribute('data-session', 's2', { timeout: 20_000 });
  await expect(card.locator('.ag-who')).toHaveText(/node fake-agent.mjs #2/);
  await expect(agentBar(page).locator('.ag-tab.cur')).toHaveText('#2');
  await page.keyboard.press('n');   // the note's tag names the session that has it
  await expect(ui(page, '.card .ag-tag.sent')).toHaveText('⤳ sent to node fake-agent.mjs #1');

  // The terminal follows the tab.
  await agentBar(page).locator('button[data-cli]').click();
  await expect(ui(page, '.win[data-win="agent"] iframe')).toHaveAttribute('src', /id=s2$/);
  await tabs.filter({ hasText: '#1' }).click();
  await expect(card).toHaveCount(0);   // #1 isn't asking
  await expect(chip(page)).toHaveText(/Done/);
  await expect(ui(page, '.win[data-win="agent"] iframe')).toHaveAttribute('src', /id=s1$/);
  await tabs.filter({ hasText: '#2' }).click();
  // #1 asks too, while #2's card is up: #2 stays. Answered, #2 hands over to #1's question.
  await request.post(`${f.url}/__redline/agent/input`, { headers: { 'x-redline': '1', 'x-redline-agent': token }, data: { id: 's1', data: 'ask\r' } });
  await expect(tabs.filter({ hasText: '#1' })).toHaveAttribute('data-state', 'blocked');
  await expect(card).toHaveAttribute('data-session', 's2');
  await card.locator('.ag-opt', { hasText: /^1Yes$/ }).click();
  await expect(card).toHaveAttribute('data-session', 's1');
  await expect(agentBar(page).locator('.ag-tab.cur')).toHaveText('#1');
  await card.locator('.ag-opt', { hasText: /^3No$/ }).click();
  await expect(chip(page)).toHaveText(/Done\s*denied/);
  await tabs.filter({ hasText: '#2' }).click();
  await expect(chip(page)).toHaveText(/Done\s*approved: yes/);

  // A phone: one session button instead of the chip, tabs, Fresh and stop; its list has them all.
  await agentBar(page).locator('button[data-cli]').click();   // the terminal and the notes panel cover a phone: closed
  await page.keyboard.press('n');
  await page.setViewportSize({ width: 390, height: 760 });
  const sw = agentBar(page).locator('button.ag-switch');
  await expect(sw).toHaveText(/#2/);
  await expect(agentBar(page).locator('.ag-tabs')).toBeHidden();
  await expect(chip(page)).toBeHidden();
  await sw.click();
  const list = ui(page, '.attach[data-toolbar="agent"] .ag-list');
  await expect(list.locator('.ag-row')).toHaveCount(2);
  await expect(list.locator('.ag-mode')).toHaveClass(/on/);
  await list.locator('.ag-row[data-id="s1"]').click();
  await expect(sw).toHaveText(/#1/);
  await expect(list).toHaveCount(0);   // picked: the list closes
  await page.setViewportSize({ width: 1280, height: 720 });

  // Stop #1: its tab gets a ×, which closes it.
  await tabs.filter({ hasText: '#1' }).click();
  await agentBar(page).locator('.ag-stop').click();
  await tabs.filter({ hasText: '#1' }).locator('.ag-x').click();
  await expect(tabs).toHaveText(['#2']);
});
