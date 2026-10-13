// The installed package, wired as the README says, works in each framework: the client is served
// from node_modules, notes land in the app's own .redline/ (default root = nearest .git), and
// source locations are repo-relative.
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PACKAGE_APPS } from './apps.ts';
import { assetExists, comment, lineOf, openOverlay, readPage, resetNotes } from '../e2e/helpers.ts';

const cases = [
  { a: PACKAGE_APPS.react, file: 'src/App.tsx', components: ['Card', 'App'] },
  { a: PACKAGE_APPS.sveltekit, file: 'src/routes/+page.svelte', components: ['+page', 'Card'] },
  { a: PACKAGE_APPS.astro, file: 'src/pages/index.astro', components: ['index', 'Card'] },
];

for (const { a, file, components } of cases) {
  test(`${a.name}: comment saves with source, components and a screenshot`, async ({ page }) => {
    await resetNotes(a);
    await openOverlay(page, a);
    const note = await comment(page, page.getByTestId('card-action'), 'Make this the primary action.');
    const line = await lineOf(path.join(a.dir, file), 'data-testid="card-action"');
    expect(note.target?.source).toMatchObject({ file, line });
    expect(note.target?.components?.slice(0, 2)).toEqual(components);
    expect(await assetExists(a, note.screenshot)).toBe(true);
    expect(await readPage(a)).toContain('Make this the primary action.');
  });
}

test('node:http server via /server: injects the client and saves notes', async ({ page }) => {
  const a = PACKAGE_APPS.node;
  await resetNotes(a);
  await openOverlay(page, a);
  const note = await comment(page, page.getByTestId('agent-save'), 'Rename to "Save as draft".');
  expect(note.target).toMatchObject({ testid: 'agent-save', tag: 'button' });
  expect(await assetExists(a, note.screenshot)).toBe(true);
  expect(await fs.readFile(path.join(a.dir, '.redline/INDEX.md'), 'utf8')).toContain('**1 open note**');
});
