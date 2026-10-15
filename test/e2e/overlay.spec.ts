// Overlay behaviour on a plain Vite page (test/fixtures/vanilla).
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './fixtures.ts';
import { assetExists, comment, mouseAt, openOverlay, readPage, resetNotes, ui, waitForSave } from './helpers.ts';

const f = FIXTURES.vanilla;
test.beforeEach(() => resetNotes(f));

test('injects the client and stays out of the way until opened', async ({ page }) => {
  await page.goto(f.url);
  await expect(page.locator('script[data-redline-client]')).toBeAttached();
  await expect(ui(page, '.launcher')).toBeVisible();
  await expect(ui(page, '.bar')).toBeHidden();
});

test('comment: app never sees the click; note has anchors, screenshot, index', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  const save = page.getByTestId('agent-save');
  await mouseAt(page, save, false);
  await expect(ui(page, '.hl-label')).toContainText('button[agent-save]');

  const note = await comment(page, save, 'Make this secondary; Publish is primary.');
  expect(await page.evaluate(() => (window as unknown as { clicked?: number }).clicked)).toBeUndefined();
  expect(note.target).toMatchObject({ testid: 'agent-save', tag: 'button', text: 'Save draft', selector: '[data-testid="agent-save"]' });
  expect(note.viewport?.slice(0, 2)).toEqual([1280, 800]);
  expect(await assetExists(f, note.screenshot)).toBe(true);
  await expect(ui(page, '.pin')).toHaveCount(1);
  await expect(ui(page, '.bar button.on')).toHaveCount(0);   // saving returns to idle (D15)

  const md = await readPage(f);
  expect(md).toMatch(/^### \[ \] Comment · `button` “Save draft” · \[data-testid="agent-save"\]$/m);
  expect(md).toContain('Make this secondary; Publish is primary.');
  expect(await fs.readFile(path.join(f.dir, '.redline/INDEX.md'), 'utf8')).toContain('**1 open note**');
});

test('opening the overlay blurs an autofocused input so mode keys work', async ({ page }) => {
  await page.goto(f.url);
  await expect(page.getByTestId('agent-name')).toBeFocused();
  await expect(ui(page, '.launcher')).toBeAttached();
  await page.keyboard.press('Alt+Shift+KeyR');
  await page.keyboard.press('c');
  await expect(ui(page, '.bar button.on')).toContainText('Comment');
  await expect(page.getByTestId('agent-name')).toHaveValue('');
});

test('disabled buttons can be picked', async ({ page }) => {
  await openOverlay(page, f);
  const note = await comment(page, page.getByTestId('agent-delete'), 'Explain why this is disabled.');
  expect(note.target?.testid).toBe('agent-delete');
});

test('alt+click and ↑ Parent widen the target; shift+click is a whole-page note', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  await mouseAt(page, page.getByTestId('agent-save'));
  await ui(page, '.pop button', ).filter({ hasText: 'Parent' }).click();
  await expect(ui(page, '.pop .what')).toContainText('section');
  await page.keyboard.press('Escape');

  const b = (await page.locator('h1').boundingBox())!;
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x + 5, b.y + 5);
  await page.keyboard.up('Shift');
  await expect(ui(page, '.pop textarea')).toBeFocused();   // L14
  await page.keyboard.type('Page feels cramped.');
  const saved = waitForSave(page);
  await page.keyboard.press('Control+Enter');
  const note = await saved;
  expect(note.whole).toBe(true);
  expect(note.target).toBeUndefined();
  expect(await readPage(f)).toContain('### [ ] Comment · whole page');
});

test('text mode: rewrite in place → diff note', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('t');
  await mouseAt(page, page.locator('p.lead'));
  await expect(ui(page, '.ed')).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Choose how your agent answers webhooks.');
  await page.keyboard.press('Enter');
  await expect(ui(page, '.pop .diff')).toBeVisible();
  await expect(ui(page, '.pop textarea')).toBeFocused();   // focused a tick later; Enter before that is lost (flaky on CI)
  const saved = waitForSave(page);
  await page.keyboard.press('Enter');            // empty note + Enter saves text changes
  const note = await saved;
  await expect(ui(page, '.bar button.on')).toHaveCount(0);
  expect(note).toMatchObject({ type: 'text', from: 'Configure how your agent responds to incoming webhooks.', to: 'Choose how your agent answers webhooks.' });
  expect(await readPage(f)).toContain('```diff\n- Configure how your agent responds to incoming webhooks.\n+ Choose how your agent answers webhooks.\n```');
});

test('sketch: records scroll, saves svg + composited png, anchors to the containing element', async ({ page }) => {
  await openOverlay(page, f);
  await page.evaluate(() => { scrollTo(0, 60); document.querySelector('.scroller')!.scrollTop = 120; });
  await page.keyboard.press('s');
  const sc = (await page.locator('.scroller').boundingBox())!;
  await page.mouse.move(sc.x + 20, sc.y + 10);
  await page.mouse.down();
  await page.mouse.move(sc.x + 300, sc.y + 90, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type('Logs need timestamps');
  const saved = waitForSave(page);
  await page.keyboard.press('Control+Enter');
  const note = await saved;
  expect(note.type).toBe('sketch');
  expect(note.scroll).toEqual([0, 60]);
  expect(note.target?.tag).toBe('div');                  // the .scroller box contains the whole drawing
  expect(await assetExists(f, note.sketch)).toBe(true);
  expect(await assetExists(f, note.screenshot)).toBe(true);
  await expect(ui(page, '.bar')).toBeVisible();          // back to the toolbar after saving
});

test('sketch text label: Enter adds it once, Escape drops it', async ({ page }) => {
  await openOverlay(page, f);
  await page.keyboard.press('s');
  await page.keyboard.press('4');
  const label = async (x: number, text: string, key: string) => {
    await page.mouse.click(x, 300);
    await expect(ui(page, '.rl-sketch-input')).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press(key);
    await expect(ui(page, '.rl-sketch-input')).toHaveCount(0);
  };
  await label(200, 'keep me', 'Enter');
  await label(500, 'drop me', 'Escape');
  await expect(ui(page, '.rl-sketch text')).toHaveText(['keep me']);   // removing the input fires blur, which used to commit again
});

test('agent edits to the markdown show up live; done/delete from the panel', async ({ page }) => {
  await openOverlay(page, f);
  const note = await comment(page, page.getByTestId('agent-save'), 'Rename to "Save as draft".');
  const file = path.join(f.dir, '.redline/pages/index.md');
  const md = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, md.replace(/^### \[ \]/m, '### [x]').replace('"Save as draft".\n', '"Save as draft".\n\n> Renamed in index.html.\n'));

  await page.keyboard.press('n');
  await ui(page, '.filters label').filter({ hasText: 'Show done' }).click();
  await expect(ui(page, '.card .reply')).toContainText('Renamed in index.html.');

  await ui(page, '.card').hover();
  await ui(page, '.card .acts button[title="Reopen"]').click();
  await expect.poll(() => fs.readFile(file, 'utf8')).toMatch(/^### \[ \] Comment/m);

  const del = ui(page, '.card .acts button[title="Delete"]');
  await del.click();
  await del.click();                                      // second click confirms
  await expect.poll(() => fs.stat(file).then(() => true, () => false)).toBe(false);
  expect(await assetExists(f, note.screenshot)).toBe(false);
});

test('an open dropdown stays open while using the toolbar, picking an item and typing (D14)', async ({ page }) => {
  await openOverlay(page, f);
  await page.getByTestId('menu-btn').click();                  // idle: the app gets the click
  const menu = page.getByTestId('menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('menu-rename')).toBeFocused();
  const closedBy = () => page.evaluate(() => (window as unknown as { menuClosedBy?: string }).menuClosedBy ?? null);

  await ui(page, '.bar .brand').click();                        // a non-focusable bit of the overlay
  await ui(page, '.bar button').filter({ hasText: 'Comment' }).click();
  expect(await closedBy()).toBeNull();
  await mouseAt(page, page.getByTestId('menu-archive'));
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type('Archive needs a confirm step.');
  await ui(page, '.pop label').click();                         // checkbox: toggled once, not twice
  await expect(ui(page, '.pop input[type=checkbox]')).not.toBeChecked();
  await ui(page, '.pop label').click();
  const saved = waitForSave(page);
  await ui(page, '.pop .btn.primary').click();
  expect((await saved).target?.testid).toBe('menu-archive');
  await expect(menu).toBeVisible();
  expect(await closedBy()).toBeNull();

  await ui(page, '.bar button').filter({ hasText: 'Comment' }).click();   // saving went back to idle (D15)
  await mouseAt(page, page.getByTestId('menu-rename'));         // Escape cancels our draft, not the app's menu
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ui(page, '.pop')).toHaveCount(0);
  expect(await closedBy()).toBeNull();
});

test('opening the overlay with the hotkey keeps a focused menu open', async ({ page }) => {
  await page.goto(f.url, { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await page.getByTestId('menu-btn').click();
  await expect(page.getByTestId('menu-rename')).toBeFocused();
  await page.keyboard.press('Alt+Shift+KeyR');
  await page.keyboard.press('c');
  await expect(ui(page, '.bar button.on')).toContainText('Comment');
  await expect(page.getByTestId('menu')).toBeVisible();
  await expect(page.getByTestId('menu-rename')).toBeFocused();
});

test('the copied prompt works for any agent: names the installed guide, or spells out the contract (D16)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const guide = path.join(f.dir, '.agents/skills/redline/SKILL.md');
  await fs.rm(path.join(f.dir, '.agents'), { recursive: true, force: true });
  const copied = async () => {
    await page.keyboard.press('n');
    await ui(page, '.panel footer .btn.primary').click();
    await expect(ui(page, '.toast')).toContainText('coding agent');
    await page.keyboard.press('n');
    return page.evaluate(() => navigator.clipboard.readText());
  };
  try {
    await openOverlay(page, f);
    await comment(page, page.getByTestId('agent-save'), 'Bigger.');
    await expect(ui(page, '.panel footer .btn.primary')).toBeHidden();
    expect(await copied()).toMatch(/^Apply the open Redline notes in .*index\.md \(1 open\)\. For each open "### \[ \]" note: .*tick it "### \[x\]"/);

    await fs.mkdir(path.dirname(guide), { recursive: true });
    await fs.writeFile(guide, '# guide\n');
    await page.reload({ waitUntil: 'networkidle' });        // config (with the guide) is read at load
    await expect(ui(page, '.bar')).toBeVisible();           // the open state survives the reload
    expect(await copied()).toMatch(/\(1 open\)\. Follow \.agents\/skills\/redline\/SKILL\.md \(the redline skill\)\.$/);
  } finally {
    await fs.rm(path.join(f.dir, '.agents'), { recursive: true, force: true });
  }
});

test('monorepo: an app pins and numbers only its own notes; All lists the other apps too (D17)', async ({ page }) => {
  const note = (id: string, app: string, testid: string) => ({
    id, app, type: 'comment', page: '/', url: f.url + '/', at: '2026-10-15 10:00', body: `${app} note`, reply: '', done: false,
    target: { testid, selector: `[data-testid="${testid}"]` }, file: `.redline/pages/${app.replace('/', '-')}--index.md`,
  });
  await page.route('**/__redline/config', r => r.fulfill({ json: { hotkey: 'alt+shift+r', launcher: true, dir: '.redline', app: 'apps/web', guide: null } }));
  await page.route('**/__redline/notes', r => r.fulfill({ json: { version: 'v1', root: '.redline',
    notes: [note('aaaa1', 'apps/admin', 'agent-save'), note('bbbb2', 'apps/web', 'agent-delete')] } }));
  await openOverlay(page, f);
  await expect(ui(page, '.pin')).toHaveCount(1);
  await expect(ui(page, '.pin')).toHaveText('1');
  await page.keyboard.press('n');
  await expect(ui(page, '.card')).toHaveCount(1);
  await expect(ui(page, '.card .body')).toHaveText('apps/web note');
  await ui(page, '.seg button').filter({ hasText: 'All' }).click();
  await expect(ui(page, '.group')).toHaveText(['/  (this page)', 'apps/admin · /']);
});
