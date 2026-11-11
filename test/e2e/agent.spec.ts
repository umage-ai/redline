// The agent panel (D53, D62) on the vanilla fixture, with a stand-in CLI (test/fixtures/agent/fake-agent.mjs)
// that reports through OSC 7501 like Claude Code. Every action lives in the agent toolbar (A, or
// alt+shift+a from anywhere): "← Agent", the state, a tab per session, Apply (long-press: switch the
// CLI), >_ for the CLI window, ⚙ for the viewer's settings; questions in a card attached to it. The
// notes panel only shows (a status line, tags on sent notes). The fixture has two CLIs: "Fake Code"
// (menus read, two models and effort levels) and "Fake Two".
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
  const post = (p: string, data: object) => request.post(`${f.url}/__redline/agent${p}`, { headers: { 'x-agent-token': token }, data });
  await post('/end', {});
  await expect.poll(async () => (await get()).sessions.length, { timeout: 15_000 }).toBe(0);
  await post('/mode', { mode: 'shared' });
  // Worktrees (D64) of this repo a test left: discarded, and the option back off.
  for (const w of (await get()).worktrees.left) await post('/worktree', { branch: w.branch, action: 'discard', confirm: true });
  await post('/worktrees', { on: false });
});

const NAME = 'Fake Code';
const terminal = (page: Page) => page.frameLocator('iframe[title$="terminal"]');
// The state shows as the toolbar's outline (and a ring on the closed launcher); hover text on the bar.
const outline = (page: Page) => ui(page, '.bar.lit[data-status="agent"]');
const agentBar = (page: Page) => ui(page, '.bar.ext .xbar[data-toolbar="agent"]');
const chip = (page: Page) => agentBar(page).locator('.ag-chip');
const apply = (page: Page) => agentBar(page).locator('button.ag-primary');
const tab = (page: Page, id: string) => agentBar(page).locator(`.ag-tab[data-id="${id}"]`);
const card = (page: Page) => ui(page, '.attach[data-toolbar="agent"] .ag-card');
const settings = (page: Page) => ui(page, '.attach[data-toolbar="agent"] .ag-set');
const cliMenu = (page: Page) => ui(page, '.attach[data-toolbar="agent"] [role="menu"]');
const win = (page: Page) => ui(page, '.win[data-win="agent"]');
const api = async (page: Page) => {
  const { token } = await (await page.request.get(`${f.url}/__redline/agent/info`)).json();
  return {
    post: (p: string, data: object) => page.request.post(`${f.url}/__redline/agent${p}`, { headers: { 'x-agent-token': token }, data }),
    info: async () => (await page.request.get(`${f.url}/__redline/agent/info`)).json(),
  };
};

test('agent toolbar: apply notes without the CLI window, answer in the card, ← Agent goes back, End in the window', async ({ page }) => {
  // The extension must load cleanly, also when the toolbar comes back after a reload (it once hit a TDZ there).
  const failures: string[] = [];
  page.on('console', m => { if (m.text().includes('extension failed')) failures.push(m.text()); });
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await comment(page, page.getByTestId('agent-save'), 'Make this secondary');

  // A opens the agent toolbar in place of the main one: ← Agent, the state (the CLI by name), Apply, >_ and ⚙.
  await page.keyboard.press('a');
  await expect(agentBar(page)).toBeVisible();
  await expect(ui(page, '.bar button[data-ext="agent"]')).toHaveCount(0);   // the main toolbar is swapped out
  await expect(ui(page, '.bar button.back')).toHaveText(/^←\s*Agent$/);
  await expect(ui(page, '.bar button.back')).toHaveAttribute('aria-label', 'Agent: Back to the Redline toolbar (Esc)');
  await expect(ui(page, '.bar .brand')).toHaveText('');   // the icon alone: the drag handle
  await expect(chip(page)).toHaveText(`${NAME} · Not started`);
  await expect(apply(page)).toHaveText('Apply 1 note');
  await expect(apply(page)).toHaveAttribute('data-count', '1');
  await expect(agentBar(page).getByRole('button', { name: 'CLI window' })).toHaveAttribute('aria-pressed', 'false');
  await expect(agentBar(page).getByRole('button', { name: 'Agent settings' })).toBeVisible();
  await expect(agentBar(page).locator('.ag-mode, .ag-end, .ag-pick')).toHaveCount(0);   // Fresh, End and ▾ left the toolbar (D62)
  await expect(win(page)).toBeHidden();

  // Apply: starts the CLI, the prompt names the note, the CLI window stays closed; a tab named by the note.
  await apply(page).click();
  await expect(outline(page)).toHaveClass(/spin/, { timeout: 20_000 });
  await expect(chip(page)).toContainText('Working');
  await expect(chip(page)).toContainText('Done');
  await expect(chip(page)).toContainText("did Apply the open Redline notes");   // the program's message (cut at 40)
  await expect(outline(page)).toHaveCSS('--dot', '#3ecf8e');
  await expect(win(page)).toBeHidden();
  await expect(tab(page, 's1')).toHaveText('Make this seconda…');
  await expect(tab(page, 's1').locator('.ag-tab-main')).toHaveAttribute('title', /^#1 · Fake Code · Done\nPrompt: Apply notes\nNotes: Make this secondary/);
  await expect(tab(page, 's1').locator('.ag-ini')).toHaveCount(0);   // one CLI in use: no initials

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
  await expect(apply(page)).toHaveAttribute('data-count', '0');
  await expect(apply(page)).toHaveText('Apply notes');
  await expect(apply(page)).toBeDisabled();

  // >_ opens the CLI window, named after the session; keys typed there reach the program, never the app.
  await page.evaluate(() => { const w = window as unknown as { appKeys: number }; w.appKeys = 0; addEventListener('keydown', () => w.appKeys++, true); });
  const term = agentBar(page).locator('button.ag-term');
  await term.click();
  await expect(win(page)).toBeVisible();
  await expect(term).toHaveAttribute('aria-pressed', 'true');
  await expect(win(page).locator('.win-title')).toHaveText('#1 · Fake Code · Make this seconda…');
  await terminal(page).locator('.xterm-screen').click();
  await page.keyboard.type('ask');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as unknown as { appKeys: number }).appKeys)).toBe(0);

  // Waiting for approval: a card attached to the toolbar shows what the CLI asks, read off its screen
  // (the diff in its colours, the question, every option); a click picks one.
  await expect(chip(page)).toHaveText(`${NAME} · Needs your approval`);   // the question is in the card; the message stays in the hover text
  await expect(chip(page)).toHaveAttribute('title', /Edit src\/App\.tsx\?/);
  await expect(outline(page)).toHaveClass(/pulse/);
  await expect(card(page).getByRole('button', { name: 'Allow' })).toHaveCount(0);   // the card has the real options
  await expect(card(page).locator('.ag-q')).toHaveText('Do you want to make this edit to src/App.tsx?');
  await expect(card(page).locator('.ag-opt')).toHaveText([/Yes$/, /Yes, and don't ask again this session/, /No$/]);
  await expect(card(page).locator('.ag-ctx')).toContainText('+  <button>+ Plan a route</button>');
  await expect(card(page).locator('.ag-ctx span', { hasText: '+  <button>' })).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const [cardBox, barBox] = [await card(page).boundingBox(), await ui(page, '.bar').boundingBox()];
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(barBox!.y);   // the toolbar sits low: the card above it
  await card(page).locator('.ag-opt', { hasText: "don't ask again" }).click();
  await expect(chip(page)).toContainText('Done');
  await expect(chip(page)).toContainText('approved: always');
  await expect(card(page)).toHaveCount(0);

  // ← Agent goes back to the main toolbar; A brings the agent toolbar again.
  await ui(page, '.bar button.back').click();
  await expect(ui(page, '.bar button[data-ext="agent"]')).toBeVisible();
  await expect(ui(page, '.bar .brand')).toHaveText('Redline');
  await expect(outline(page)).toHaveAttribute('title', /done · approved: always/);   // the outline stays on the main toolbar
  await ui(page, '.bar button[data-ext="agent"]').click();
  await expect(agentBar(page)).toBeVisible();

  // A reload keeps the toolbar (and the window); End session in the window's header (done: no
  // confirmation) stops the CLI and closes the session in one: back to "Not started", Start in the window.
  await page.reload();
  await expect(agentBar(page)).toBeVisible();
  await expect(win(page)).toBeVisible();
  await expect(ui(page, '.panel section[data-ext="agent"] .ag-line')).toContainText('1 done');   // the panel part came up too
  const endB = win(page).locator('.win-controls .ag-wend');
  await expect(endB).toHaveText('End session');
  await endB.click();
  await expect(chip(page)).toHaveText(`${NAME} · Not started`);
  await expect(terminal(page).getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(agentBar(page).locator('.ag-tab')).toHaveCount(0);
  await expect(endB).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('agent toolbar: its shortcut opens the overlay in it from anywhere, Esc closes a popover then steps back, a mode leaves it', async ({ page }) => {
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
  // ⚙ open: Esc closes it first (focus back on ⚙), then goes back to the main toolbar.
  const gear = agentBar(page).locator('button.ag-gear');
  await gear.click();
  await expect(settings(page)).toBeVisible();
  await expect(gear).toHaveAttribute('aria-expanded', 'true');
  await ui(page, '.attach .ag-set footer button').focus();   // a button: Esc reaches the overlay's own handler
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await expect(agentBar(page)).toBeVisible();
  await expect(gear).toBeFocused();
  await page.keyboard.press('Escape');   // back to the main toolbar, overlay still open
  await expect(ui(page, '.bar button[data-ext="agent"]')).toBeVisible();
  await page.keyboard.press('a');
  await expect(agentBar(page)).toBeVisible();
  await page.keyboard.press('c');   // a mode swaps the main toolbar back
  await expect(ui(page, '.bar button.on')).toHaveText(/Comment/);
  await expect(agentBar(page)).toHaveCount(0);
});

test('agent toolbar: stepped questions in the attached card (steps, descriptions, a typed answer, review), below a toolbar moved up', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('a');
  await expect(agentBar(page)).toBeVisible();
  const a = await api(page);
  await a.post('/start', {});
  await expect(chip(page)).toContainText('Ready', { timeout: 20_000 });
  await a.post('/input', { data: 'form\r' });

  await expect(chip(page)).toContainText('Needs your answer');
  await expect(card(page).locator('.ag-steps button:not(.nav)')).toHaveText(['☐ Color', '☐ Size', '✔ Submit']);
  await expect(card(page).locator('.ag-steps button.cur')).toHaveText('☐ Color');
  await expect(card(page).locator('.ag-q')).toHaveText('Which colour should the button be?');
  await expect(card(page).locator('.ag-opt').nth(1)).toContainText('Calm and trustworthy, a common default.');
  await card(page).locator('.ag-opt', { hasText: 'Blue' }).click();

  // Step 2: an answer of our own, typed into the card.
  await expect(card(page).locator('.ag-q')).toHaveText('Which size should the button be?');
  await expect(card(page).locator('.ag-steps button.done')).toHaveText('☒ Color');
  await card(page).locator('.ag-input input').fill('XL');
  await card(page).locator('.ag-input input').press('Enter');

  // Review: what was answered, then Submit.
  await expect(card(page).locator('.ag-q')).toHaveText('Ready to submit your answers?');
  await expect(card(page).locator('.ag-ctx')).toContainText('→ Blue');
  await expect(card(page).locator('.ag-ctx')).toContainText('→ XL');

  // The toolbar dragged to the top half by its icon (draggable is on by default): the card goes below it.
  const grip = (await ui(page, '.bar .brand').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, 120, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => localStorage.removeItem('redline:pos:bar'));   // later tests start with the bar in place
  const [cardBox, barBox] = [await card(page).boundingBox(), await ui(page, '.bar').boundingBox()];
  expect(cardBox!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height);

  await card(page).locator('.ag-opt', { hasText: 'Submit answers' }).click();
  await expect(chip(page)).toContainText('answered: Color=Blue, Size=XL');
  await expect(card(page)).toHaveCount(0);
});

test('agent toolbar: fresh sessions, a tab each, named by their notes; a waiting tab opens its card; the CLI window follows the tab; phones', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await comment(page, page.getByTestId('agent-save'), 'Make this secondary, a purple outline');
  await page.keyboard.press('a');
  await expect(apply(page)).toHaveAttribute('data-count', '1');

  // Fresh, in ⚙: every prompt starts its own session.
  await agentBar(page).locator('button.ag-gear').click();
  await settings(page).getByRole('radio', { name: /New session per prompt/ }).check();
  await expect.poll(async () => (await (await api(page)).info()).mode).toBe('fresh');
  await agentBar(page).locator('button.ag-gear').click();
  await apply(page).click();
  const tabs = agentBar(page).locator('.ag-tab');
  await expect(tabs).toHaveText(['Make this seconda…'], { timeout: 20_000 });
  await expect(chip(page)).toContainText('Done', { timeout: 20_000 });
  // While #1 runs, the note is its: a second session wouldn't get it.
  await expect(apply(page)).toBeDisabled();

  // A second session asks (no notes, no name: its number); its tab comes up with the card.
  const a = await api(page);
  const r = await a.post('/send', { text: 'ask' });
  expect((await r.json()).id).toBe('s2');
  await expect(tab(page, 's2')).toHaveText('#2');
  await expect(card(page)).toHaveAttribute('data-session', 's2', { timeout: 20_000 });
  await expect(card(page).locator('.ag-who')).toHaveText(/Fake Code #2/);
  await expect(agentBar(page).locator('.ag-tab.cur')).toHaveAttribute('data-id', 's2');
  // Busy and asking first; #1 (done, seen) to the right, faded.
  await expect(tabs).toHaveText(['#2', 'Make this seconda…']);
  await expect(tab(page, 's1')).toHaveAttribute('data-state', 'seen');
  // The notes panel opens beside the toolbar, which wraps into the room left: the card moves up with it (L59).
  await page.setViewportSize({ width: 1100, height: 800 });
  const barH = (await ui(page, '.bar').boundingBox())!.height;
  await page.keyboard.press('n');   // the note's tag names the session that has it
  await expect(ui(page, '.card .ag-tag.sent')).toHaveText(`⤳ sent to ${NAME} #1`);
  const [cb, bb] = [(await card(page).boundingBox())!, (await ui(page, '.bar').boundingBox())!];
  expect(bb.height).toBeGreaterThan(barH + 10);   // wrapped
  expect(cb.y + cb.height).toBeLessThanOrEqual(bb.y);
  await page.keyboard.press('n');   // closed again: the CLI window and the panel would cover the toolbar
  await page.setViewportSize({ width: 1280, height: 800 });

  // The CLI window follows the tab.
  await agentBar(page).locator('button.ag-term').click();
  await expect(ui(page, '.win[data-win="agent"] iframe')).toHaveAttribute('src', /id=s2$/);
  await tab(page, 's1').locator('.ag-tab-main').click();
  await expect(card(page)).toHaveCount(0);   // #1 isn't asking
  await expect(chip(page)).toContainText('Done');
  await expect(ui(page, '.win[data-win="agent"] iframe')).toHaveAttribute('src', /id=s1$/);
  await expect(win(page).locator('.win-title')).toHaveText('#1 · Fake Code · Make this seconda…');
  // A tab waiting for you: a click opens its card.
  await tab(page, 's2').locator('.ag-tab-main').click();
  await expect(card(page)).toHaveAttribute('data-session', 's2');
  // #1 asks too, while #2's card is up: #2 stays. Answered, #2 hands over to #1's question.
  await a.post('/input', { id: 's1', data: 'ask\r' });
  await expect(tab(page, 's1')).toHaveAttribute('data-state', 'blocked');
  await expect(card(page)).toHaveAttribute('data-session', 's2');
  await card(page).locator('.ag-opt', { hasText: /^1Yes$/ }).click();
  await expect(card(page)).toHaveAttribute('data-session', 's1');
  await expect(agentBar(page).locator('.ag-tab.cur')).toHaveAttribute('data-id', 's1');
  await card(page).locator('.ag-opt', { hasText: /^3No$/ }).click();
  await expect(chip(page)).toContainText('denied');
  await tab(page, 's2').locator('.ag-tab-main').click();
  await expect(chip(page)).toContainText('approved: yes');

  // A phone: one session button instead of the state and tabs; Apply, >_ and ⚙ stay; its list has every session and End.
  await agentBar(page).locator('button.ag-term').click();   // the CLI window covers a phone: closed
  await page.setViewportSize({ width: 390, height: 760 });
  const sw = agentBar(page).locator('button.ag-switch');
  await expect(sw).toHaveText('#2');
  await expect(agentBar(page).locator('.ag-tabs')).toBeHidden();
  await expect(chip(page)).toBeHidden();
  for (const b of ['button.ag-primary', 'button.ag-term', 'button.ag-gear']) await expect(agentBar(page).locator(b)).toBeInViewport();
  await expect(ui(page, '.bar button.close')).toBeInViewport();   // the row fits: nothing scrolled off
  await sw.click();
  const list = ui(page, '.attach[data-toolbar="agent"] .ag-list');
  await expect(list.locator('.ag-row')).toHaveCount(2);
  await list.locator('.ag-row[data-id="s1"] .ag-row-main').click();
  await expect(sw).toHaveText('Make this seconda…');
  await expect(list).toHaveCount(0);   // picked: the list closes
  await page.setViewportSize({ width: 1280, height: 720 });

  // Every tab has a ×: it ends that session (stop + close in one; #1 is done, so no confirmation).
  await tab(page, 's1').locator('.ag-x').click();
  await expect(tabs).toHaveText(['#2']);
});

test('agent toolbar: End asks first while the agent is busy (a tab\'s ×, the CLI window), then stops and closes the session; — minimizes, the session runs on', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('a');
  const a = await api(page);
  await a.post('/start', {});
  await expect(chip(page)).toContainText('Ready', { timeout: 20_000 });
  await a.post('/input', { data: 'ask\r' });
  await expect(chip(page)).toContainText('Needs your approval');
  const x = tab(page, 's1').locator('.ag-x');
  await expect(x).toHaveAttribute('aria-label', 'End #1');
  await x.click();
  await expect(x).toHaveText('End?');   // armed, nothing stopped yet
  await expect(chip(page)).toContainText('Needs your approval');
  await x.click();
  await expect(chip(page)).toContainText('Not started');
  expect((await a.info()).sessions).toEqual([]);

  // The CLI window: a slow prompt keeps it working; — hides the window, the session runs on.
  await a.post('/send', { text: 'slow work', title: 'Slow one' });
  await expect(chip(page)).toContainText('Working', { timeout: 20_000 });
  await agentBar(page).locator('button.ag-term').click();
  await expect(win(page).locator('.win-title')).toHaveText('#1 · Fake Code · Slow one');
  const min = win(page).locator('.win-close');
  await expect(min).toHaveText('—');
  await min.click();
  await expect(win(page)).toBeHidden();
  await expect(chip(page)).toContainText('Working');
  expect((await a.info()).sessions[0].running).toBe(true);
  await agentBar(page).locator('button.ag-term').click();   // >_ again: the same session
  await expect(win(page)).toBeVisible();
  const endB = win(page).locator('.win-controls .ag-wend');
  await endB.click();
  await expect(endB).toHaveText('End? Press again');
  await expect(chip(page)).toContainText('Working');
  await endB.click();
  await expect(chip(page)).toContainText('Not started');
  expect((await a.info()).sessions).toEqual([]);
});

test('agent toolbar: hold Apply (or right-click, Alt+↓) to switch the CLI; remembered in this browser; initials once two CLIs run (D62)', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await comment(page, page.getByTestId('agent-save'), 'Make this secondary');
  await page.keyboard.press('a');
  const a = await api(page);
  await expect(apply(page)).toHaveAttribute('title', /Hold, right-click or Alt\+↓ to switch the agent/);
  await expect(apply(page)).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowDown Shift+F10');

  // Long-press: the switch opens on the current CLI, and nothing runs.
  const b = (await apply(page).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(cliMenu(page).getByRole('menuitemradio')).toHaveText([/^Fake Code/, /^Fake Two/]);
  await expect(cliMenu(page).getByRole('menuitemradio', { name: /Fake Code/ })).toHaveAttribute('aria-checked', 'true');
  await expect(cliMenu(page).getByRole('menuitemradio', { name: /Fake Code/ })).toBeFocused();
  expect((await a.info()).sessions).toEqual([]);   // the click after the hold was dropped
  await page.keyboard.press('Escape');
  await expect(cliMenu(page)).toHaveCount(0);
  await expect(apply(page)).toBeFocused();

  // Right-click opens it too; so do Alt+↓ and Shift+F10 on the focused button. ↓ and Enter pick; focus goes back to Apply.
  await apply(page).click({ button: 'right' });
  await expect(cliMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await apply(page).focus();
  await page.keyboard.press('Shift+F10');
  await expect(cliMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(cliMenu(page).getByRole('menuitemradio', { name: /Fake Code/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(cliMenu(page).getByRole('menuitemradio', { name: /Fake Two/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cliMenu(page)).toHaveCount(0);
  await expect(apply(page)).toBeFocused();
  await expect(apply(page)).toHaveAttribute('title', /with Fake Two/);

  // Apply runs the picked CLI; its tab and the state name it.
  await apply(page).click();
  await expect(tab(page, 's1')).toBeVisible({ timeout: 20_000 });
  await expect(tab(page, 's1').locator('.ag-tab-main')).toHaveAttribute('title', /^#1 · Fake Two · /);
  await expect(chip(page)).toHaveAttribute('title', /^Fake Two: /);
  await expect.poll(async () => (await a.info()).sessions.map((x: { cli: string; app?: string }) => `${x.cli}:${x.app}`), { timeout: 20_000 }).toEqual(['fake-two:fake-two']);

  // Remembered across a reload; with two CLIs running (fresh), each tab carries its CLI's initials.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  // A reload comes back to the same view (sessionStorage), where the shortcut would close the overlay.
  if (!(await agentBar(page).isVisible())) await page.keyboard.press('Alt+Shift+KeyA');
  await expect(apply(page)).toHaveAttribute('title', /with Fake Two/);
  await a.post('/mode', { mode: 'fresh' });
  await a.post('/send', { text: 'hello', cli: 'fake' });
  await expect(tab(page, 's2')).toBeVisible({ timeout: 20_000 });
  await expect(tab(page, 's1').locator('.ag-ini')).toHaveText('FT');
  await expect(tab(page, 's2').locator('.ag-ini')).toHaveText('FC');

  // A phone keeps the switch: right-click on Apply (taken by the sessions: disabled, the switch still opens).
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(apply(page)).toBeInViewport();
  await expect(apply(page)).toBeDisabled();
  const pb = (await apply(page).boundingBox())!;
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2, { button: 'right' });
  await cliMenu(page).getByRole('menuitemradio', { name: /Fake Code/ }).click();
  await expect(apply(page)).toHaveAttribute('title', /with Fake Code/);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('agent toolbar: ⚙ settings: CLI, model and effort per CLI, sessions; remembered after a reload; only offered values reach the CLI; reset (D62)', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await comment(page, page.getByTestId('agent-save'), 'Make this secondary');
  await page.keyboard.press('a');
  const a = await api(page);
  const gear = agentBar(page).locator('button.ag-gear');
  await gear.click();
  const set = settings(page);
  await expect(set).toHaveAttribute('role', 'dialog');
  await expect(set.getByRole('radio', { name: /Fake Code/ })).toBeFocused();   // opened on the current CLI
  await expect(set.getByRole('radio', { name: /Fake Code/ })).toBeChecked();
  const model = set.getByLabel('Model'), effort = set.getByLabel('Effort');
  await expect(model.locator('option')).toHaveText(['Default', 'Fast', 'Smart']);
  await expect(effort.locator('option')).toHaveText(['Default', 'low', 'high']);
  await expect(set.getByRole('radio', { name: /Keep one session going/ })).toBeChecked();   // the project's sessions: 'shared'
  await expect(set.locator('footer')).toContainText('Applies to new sessions.');

  // Picked per CLI: Fake Two offers neither (they hide), Fake Code keeps its own.
  await model.selectOption('smart');
  await effort.selectOption('high');
  await set.getByRole('radio', { name: /Fake Two/ }).check();
  await expect(set.getByLabel('Model')).toHaveCount(0);
  await expect(set.locator('.ag-note')).toHaveText('Fake Two offers no model or effort choice here: it uses its own config.');
  await expect(apply(page)).toHaveAttribute('title', /with Fake Two/);
  await set.getByRole('radio', { name: /Fake Code/ }).check();
  await expect(set.getByLabel('Model')).toHaveValue('smart');
  await expect(set.getByLabel('Effort')).toHaveValue('high');

  // Remembered after a reload (this browser), and sent with the prompt: the CLI gets them as flags.
  await page.reload({ waitUntil: 'networkidle' });
  if (!(await agentBar(page).isVisible())) await page.keyboard.press('Alt+Shift+KeyA');
  await gear.click();
  await expect(settings(page).getByLabel('Model')).toHaveValue('smart');
  await expect(settings(page).getByLabel('Effort')).toHaveValue('high');
  await gear.click();
  await expect(settings(page)).toHaveCount(0);
  await apply(page).click();
  await expect.poll(async () => (await a.info()).sessions.map((x: { model?: string; effort?: string }) => `${x.model}/${x.effort}`), { timeout: 20_000 }).toEqual(['smart/high']);
  await agentBar(page).locator('button.ag-term').click();
  await expect(terminal(page).locator('.xterm-rows')).toContainText('fake agent starting with --model smart --effort high', { timeout: 20_000 });
  await expect(tab(page, 's1').locator('.ag-tab-main')).toHaveAttribute('title', /Model: smart · Effort: high/);
  // Something it didn't offer never reaches the CLI.
  expect((await a.post('/send', { text: 'x', cli: 'fake', model: 'smart; rm -rf' })).status()).toBe(400);

  // Sessions: the server's mode. Reset: the project's CLI, model, effort and sessions again; Esc in a field closes.
  await gear.click();
  await settings(page).getByRole('radio', { name: /New session per prompt/ }).check();
  await expect.poll(async () => (await a.info()).mode).toBe('fresh');
  await settings(page).getByRole('radio', { name: /Fake Two/ }).check();
  await settings(page).getByRole('button', { name: 'Reset to project defaults' }).click();
  await expect(settings(page).getByRole('radio', { name: /Fake Code/ })).toBeChecked();
  await expect(settings(page).getByLabel('Model')).toHaveValue('');
  await expect(settings(page).getByLabel('Effort')).toHaveValue('');
  await expect(settings(page).getByRole('radio', { name: /Keep one session going/ })).toBeChecked();
  expect((await a.info()).mode).toBe('shared');
  expect(await page.evaluate(() => [localStorage.getItem('redline.agent.settings'), localStorage.getItem('redline.agent.cli')])).toEqual([null, null]);
  await settings(page).getByLabel('Model').focus();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toHaveCount(0);
  await expect(gear).toBeFocused();
  await expect(agentBar(page)).toBeVisible();
});

test('agent toolbar: ⚙ worktrees: a fresh session on its own branch; when it ends, keep, merge or discard (D64)', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await comment(page, page.getByTestId('agent-save'), 'Make this secondary');
  await page.keyboard.press('a');
  const a = await api(page);
  await a.post('/mode', { mode: 'fresh' });
  const gear = agentBar(page).locator('button.ag-gear');
  await gear.click();
  const toggle = settings(page).getByRole('checkbox', { name: 'Each new session in its own git worktree' });
  await expect(toggle).toBeEnabled();   // the fixture lives in a git repo
  await expect(toggle).not.toBeChecked();
  await expect(settings(page).locator('#ag-wt-help')).toContainText('No node_modules there');
  await toggle.check();
  await expect.poll(async () => (await a.info()).worktrees.on).toBe(true);
  await gear.click();

  // Apply: the session runs in .redline/worktrees/<name> on redline/<name> (its tab's name), and the tab says so.
  await apply(page).click();
  await expect(chip(page)).toContainText('Done', { timeout: 30_000 });
  const s1 = (await a.info()).sessions[0];
  expect(s1.worktree.branch).toBe('redline/make-this-seconda');
  expect(s1.worktree.path).toBe('.redline/worktrees/make-this-seconda');
  await expect(tab(page, s1.id).locator('.ag-tab-main')).toHaveAttribute('title', /Branch: redline\/make-this-seconda/);
  await expect(agentBar(page).locator('button.ag-branches')).toHaveCount(0);

  // Ended: the branch's choice opens in the card; a branch button keeps it reachable.
  await tab(page, s1.id).locator('.ag-x').click();
  const card = ui(page, '.attach[data-toolbar="agent"] .ag-wts');
  await expect(card).toBeVisible();
  const row = card.locator('.ag-wt[data-branch="redline/make-this-seconda"]');
  await expect(row.locator('.ag-wt-sub')).toContainText('no changes');
  await expect(row.getByRole('button')).toHaveText(['Keep branch', /^Merge into /, 'Discard']);
  await expect(row.getByRole('button', { name: 'Keep branch' })).toBeFocused();
  await expect(agentBar(page).locator('button.ag-branches')).toHaveAttribute('aria-label', '1 branch to keep, merge or discard');
  // Nothing on it: Discard goes at once (with work on it, it asks first; the unit tests cover that).
  await row.getByRole('button', { name: 'Discard' }).click();
  await expect(ui(page, '.toast')).toContainText('Discarded redline/make-this-seconda');
  await expect(row).toHaveCount(0);
  await expect(agentBar(page).locator('button.ag-branches')).toHaveCount(0);
  expect((await a.info()).worktrees.left).toEqual([]);
});

test('agent toolbar: attachments (D56): a 📎 count on the tab; the card lists the prompt\'s changed files (with a diff), links, mentions', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('a');
  const a = await api(page);
  // In a worktree, so the stand-in's file lands on a throwaway branch (discarded after the test).
  await a.post('/mode', { mode: 'fresh' });
  await a.post('/worktrees', { on: true });
  const sent = await (await a.post('/send', { text: 'write out.txt hello link', title: 'Files', task: 'Try files' })).json();
  await expect(chip(page)).toContainText('Done', { timeout: 30_000 });
  const clip = tab(page, sent.id).locator('button.ag-att');
  await expect(clip).toHaveText('2');   // the changed file and the link; mentions aren't counted
  await expect(clip).toHaveAttribute('aria-label', '2 attachments of Files');
  await clip.click();
  const files = ui(page, '.attach[data-toolbar="agent"] .ag-files');
  await expect(files).toBeVisible();
  await expect(clip).toHaveAttribute('aria-expanded', 'true');
  await expect(files.locator('.ag-round-h')).toHaveText(/Prompt 1\s*Try files/);
  const row = files.locator('button.ag-frow', { hasText: 'out.txt' });
  await expect(row).toContainText('A');
  await expect(row).toContainText('+1 −0');
  await expect(row).toBeFocused();
  await row.click();
  await expect(files.locator('pre.ag-diff')).toContainText('+hello link');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  // A link on this machine opens in a new tab; the mention (a file that exists) sits folded below.
  const link = files.locator('a.ag-frow', { hasText: 'the preview' });
  await expect(link).toHaveAttribute('href', 'http://localhost:5199/preview');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(files.locator('details.ag-ment summary')).toHaveText(/Mentioned \(\d+\)/);
  await files.locator('details.ag-ment summary').click();
  const mention = files.locator('details.ag-ment a.ag-frow', { hasText: 'index.html' });
  await expect(mention).toHaveAttribute('href', /\/__redline\/agent\/file\?id=.*path=index\.html/);
  // Served from the session's folder (its worktree), text as text.
  const served = await page.request.get(f.url + (await mention.getAttribute('href'))!);
  expect(served.headers()['content-type']).toContain('text/plain');
  expect(await served.text()).toContain('<');
  await clip.click();
  await expect(files).toHaveCount(0);
});

test('agent toolbar: the note an agent says it is on (MCP working_on, D66) is tagged as worked on, its other notes wait; the tab says which', async ({ page, request }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  const first = await comment(page, page.getByTestId('agent-save'), 'Make this secondary');
  await page.keyboard.press('c');
  const second = await comment(page, page.getByTestId('agent-delete'), 'Explain why it is off');
  await page.keyboard.press('a');
  const a = await api(page);
  const { id } = await (await a.post('/send', { text: 'slower work', notes: [first.id, second.id], title: 'Two' })).json();
  // Typed (its round has begun) and working.
  await expect.poll(async () => (await a.info()).sessions[0]?.rounds, { timeout: 20_000 }).toBe(1);
  await expect(chip(page)).toContainText('Working', { timeout: 20_000 });
  // An agent Redline didn't start names its session; one it started is known by its connection.
  const r = await request.post(`${f.url}/__redline/mcp`, { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'working_on', arguments: { id: second.id, session: id } } } });
  expect((await r.json()).result.content[0].text).toContain(`is on note ${second.id}`);
  await expect(tab(page, id).locator('.ag-tab-main')).toHaveAttribute('title', /On: Explain why it is off/);
  await page.keyboard.press('n');
  await expect(ui(page, `.card[data-id="${second.id}"] .ag-tag`)).toHaveText(`${NAME} is working on it`);
  await expect(ui(page, `.card[data-id="${first.id}"] .ag-tag`)).toHaveText(`⤳ sent to ${NAME}, next`);
});
