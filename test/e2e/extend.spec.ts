// Extension points in the browser: overlay extensions (D21) and direct source edits (D20).
// The vanilla fixture loads test/fixtures/vanilla/redline.ext.js and, like the Astro
// fixture, has directEdit on, as do the other fixture apps. Edit tests change a fixture file and restore it.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FIXTURES, type Fixture } from './fixtures.ts';
import { comment, mouseAt, openOverlay, resetNotes, ui, waitForSave } from './helpers.ts';

const events = (page: Page) => page.evaluate(() => (window as unknown as { extEvents: string[] }).extEvents);

test('an extension adds a toolbar button with a key, a panel section, and hears events', async ({ page }) => {
  const f = FIXTURES.vanilla;
  await resetNotes(f);
  await openOverlay(page, f);
  const ping = ui(page, '.bar button[data-ext="ping"]');
  await expect(ping).toContainText('Ping');
  await expect(ping).not.toHaveClass(/on/);
  await page.keyboard.press('p');
  await expect(ui(page, '.toast')).toHaveText('pong');
  await expect(ping).toHaveClass(/on/);   // active() re-read after rl.render()
  await ping.click();
  expect(await page.evaluate(() => (window as unknown as { pinged: number }).pinged)).toBe(2);

  await comment(page, page.getByTestId('agent-save'), 'Extension sees this.');
  await page.keyboard.press('n');
  await expect(ui(page, '.panel section[data-ext="fixture"]')).toContainText('Hello from an extension · 1 notes');
  // 'open' may fire before the extension module has loaded
  expect((await events(page)).filter(e => e !== 'open')).toEqual(['mode:comment', 'noteCreated']);
});

/** A fixture file the test edits: restored afterwards (also if a step fails). */
async function editable(f: Fixture, rel: string) {
  const file = path.join(f.dir, rel);
  const original = await fs.readFile(file, 'utf8');
  return { read: () => fs.readFile(file, 'utf8'), restore: async () => { if ((await fs.readFile(file, 'utf8')) !== original) await fs.writeFile(file, original); } };
}

/** Text mode on target, then edit it with the keyboard; ends with the popover open. */
async function edit(page: Page, target: Locator, keys: () => Promise<void>) {
  await expect(ui(page, '.bar')).toBeVisible();
  if (!(await ui(page, '.bar button.on').filter({ hasText: 'Text' }).count())) await page.keyboard.press('t');
  await mouseAt(page, target);
  await expect(ui(page, '.ed')).toBeFocused();
  await keys();
  await page.keyboard.press('Enter');
  await expect(ui(page, '.pop .diff')).toBeVisible();
}

// Each app renders the same three elements (EditZone / edit.astro / edit.html): a static
// heading, a paragraph with inline markup, and a paragraph whose text is computed.
const cases = [
  { f: FIXTURES.vanilla, rel: 'edit.html', route: '/edit.html', dynamic: /rendered by script/ },
  { f: FIXTURES.react, rel: 'src/EditZone.tsx', route: '/', dynamic: /expression/ },
  { f: FIXTURES.sveltekit, rel: 'src/lib/EditZone.svelte', route: '/', dynamic: /expression/ },
  { f: FIXTURES.astro, rel: 'src/pages/edit.astro', route: '/edit', dynamic: /expression/ },
];

for (const c of cases) {
  test(`${c.f.name}: text mode writes to ${c.rel}, keeps inline markup, refuses computed text`, async ({ page }) => {
    await resetNotes(c.f);
    const file = await editable(c.f, c.rel);
    try {
      await openOverlay(page, c.f, c.route);
      const apply = ui(page, '.pop .btn.apply');

      // computed text: no button, and the reason why
      await edit(page, page.getByTestId('edit-dynamic'), async () => { await page.keyboard.press('Control+A'); await page.keyboard.type('Count 3'); });
      await expect(ui(page, '.pop .why')).toContainText(c.dynamic);
      await expect(apply).toBeDisabled();
      await page.keyboard.press('Escape');

      // plain text
      await edit(page, page.getByTestId('edit-heading'), async () => { await page.keyboard.press('Control+A'); await page.keyboard.type('Edited & saved'); });
      await expect(apply).toBeEnabled();
      await expect(apply).toHaveClass(/primary/);
      await expect(ui(page, '.pop .btn').filter({ hasText: 'Save note' })).toBeVisible();
      await apply.click();
      await expect.poll(file.read).toContain('<h2 data-testid="edit-heading">Edited &amp; saved</h2>');
      await expect(page.getByTestId('edit-heading')).toHaveText('Edited & saved');   // HMR or reload
      await expect(ui(page, '.pop')).toHaveCount(0);

      // inline markup: the rich editor keeps <b> and <a …> exactly as written, entities too
      await edit(page, page.getByTestId('edit-rich'), async () => {
        await expect(ui(page, '.ed.rich b')).toHaveText('chips');
        await page.keyboard.type(' now');
      });
      await expect(apply).toBeEnabled();
      await apply.click();
      await expect.poll(file.read).toMatch(/>Fish &amp; <b>chips<\/b> on the <a class(Name)?="menu" href="#menu">menu<\/a> daily now<\/p>/);
      await expect(page.getByTestId('edit-rich')).toHaveText('Fish & chips on the menu daily now');
      await expect(page.getByTestId('edit-rich').locator('b')).toHaveText('chips');

      await expect.poll(() => fs.stat(path.join(c.f.dir, '.redline')).then(() => true, () => false)).toBe(false);   // no notes
    } finally { await file.restore(); }
  });
}

test('rich editor: Ctrl+B bolds a word and the new <b> is written', async ({ page }) => {
  const f = FIXTURES.vanilla;
  await resetNotes(f);
  const file = await editable(f, 'edit.html');
  try {
    await openOverlay(page, f, '/edit.html');
    await edit(page, page.getByTestId('edit-rich'), async () => {
      await page.keyboard.press('Control+Shift+ArrowLeft');   // select "daily"
      await page.keyboard.press('Control+b');
    });
    await ui(page, '.pop .btn.apply').click();
    await expect.poll(file.read).toContain('<a class="menu" href="#menu">menu</a> <b>daily</b></p>');
  } finally { await file.restore(); }
});

test('if the write fails after the check, the edit falls back to a text note for the agent', async ({ page }) => {
  const f = FIXTURES.react;   // hot reload keeps the overlay open (a static .html change reloads the page)
  await resetNotes(f);
  const file = await editable(f, 'src/EditZone.tsx');
  try {
    await openOverlay(page, f);
    await edit(page, page.getByTestId('edit-heading'), async () => { await page.keyboard.press('Control+A'); await page.keyboard.type('Better heading'); });
    const apply = ui(page, '.pop .btn.apply');
    await expect(apply).toBeEnabled();
    // someone (an agent, the reviewer's editor) changes the heading in source meanwhile
    await fs.writeFile(path.join(f.dir, 'src/EditZone.tsx'), (await file.read()).replace('>Static heading<', '>Changed elsewhere<'));
    await apply.click();
    await expect(ui(page, '.pop .why')).toContainText(/Can't apply to the file: .*differs/);
    await expect(apply).toBeDisabled();
    const save = ui(page, '.pop .btn.primary');
    await expect(save).toHaveText('Save note');
    const saved = waitForSave(page);
    await save.click();
    expect(await saved).toMatchObject({ type: 'text', from: 'Static heading', to: 'Better heading' });
  } finally { await file.restore(); }
});
