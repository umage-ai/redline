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
  // One agent per dev server: leave it stopped for the next test.
  const info = await (await request.get(`${f.url}/__redline/agent/info`)).json();
  await request.post(`${f.url}/__redline/agent/stop`, { headers: { 'x-redline': '1', 'x-redline-agent': info.token }, data: {} });
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

  // Waiting for approval: the toolbar asks, with the program's question; Allow and Deny answer it.
  await expect(chip(page)).toHaveText(/Needs your approval\s*Edit src\/App\.tsx\?/);
  await expect(outline(page)).toHaveClass(/pulse/);
  await expect(apply).toHaveCount(0);
  await agentBar(page).getByRole('button', { name: 'Allow' }).click();
  await expect(chip(page)).toHaveText(/Done\s*approved: yes/);
  await terminal(page).locator('.xterm-screen').click();
  await page.keyboard.type('ask');
  await page.keyboard.press('Enter');
  await agentBar(page).getByRole('button', { name: 'Deny' }).click();
  await expect(chip(page)).toHaveText(/Done\s*denied/);

  // ✕ goes back to the main toolbar; A brings the agent toolbar again.
  await ui(page, '.bar button.back').click();
  await expect(ui(page, '.bar button[data-ext="agent"]')).toBeVisible();
  await expect(outline(page)).toHaveAttribute('title', /done · denied/);   // the outline stays on the main toolbar
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
