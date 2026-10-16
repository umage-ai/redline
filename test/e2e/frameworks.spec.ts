// Source location + component chain per framework. Each fixture renders
// <button data-testid="card-action"> inside a <Card> component, written in the page file.
// Chains: React and Vue walk the component tree (Card renders the slot, inside App); Svelte,
// Astro, Angular, Solid and Preact list the component the element is written in first.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { FIXTURES } from './fixtures.ts';
import { comment, lineOf, openOverlay, resetNotes, ui } from './helpers.ts';

const cases = [
  { f: FIXTURES.react, file: 'src/App.tsx', components: ['Card', 'App'] },
  { f: FIXTURES.sveltekit, file: 'src/routes/+page.svelte', components: ['+page', 'Card'] },
  { f: FIXTURES.astro, file: 'src/pages/index.astro', components: ['index', 'Card'] },
  { f: FIXTURES.vue, file: 'src/App.vue', components: ['Card', 'App'] },
  { f: FIXTURES.angular, file: 'src/app/app.html', components: ['App', 'Card'] },
  { f: FIXTURES.solid, file: 'src/App.tsx', components: ['App', 'Card'] },
  { f: FIXTURES.preact, file: 'src/App.tsx', components: ['App', 'Card'] },
];

for (const { f, file, components } of cases) {
  test(`${f.name}: note points at ${file}:line and the component chain`, async ({ page }) => {
    await resetNotes(f);
    await openOverlay(page, f);
    const note = await comment(page, page.getByTestId('card-action'), 'Make this the primary action.');
    const line = await lineOf(path.join(f.dir, file), 'data-testid="card-action"');
    expect(note.target?.source).toMatchObject({ file, line });
    expect(note.target?.components?.slice(0, 2)).toEqual(components);
    expect(note.target?.html).not.toMatch(/data-redline-src|data-ng-source-location/);   // stamps are noise for the agent
  });
}

test('astro: works although the dev toolbar strips data-astro-source-*, and the bar sits above it', async ({ page }) => {
  await openOverlay(page, FIXTURES.astro);
  await expect(page.locator('astro-dev-toolbar')).toBeAttached();
  await expect.poll(() => page.locator('[data-astro-source-file]').count()).toBe(0);
  await expect.poll(() => ui(page, '.rl').evaluate(el => (el as HTMLElement).style.getPropertyValue('--lift'))).toBe('52px');
});

test('angular: an element in an inline template points at the component .ts, line and column', async ({ page }) => {
  const f = FIXTURES.angular;
  await resetNotes(f);
  await openOverlay(page, f);
  const note = await comment(page, page.getByTestId('card-title'), 'Title too small.');
  const line = await lineOf(path.join(f.dir, 'src/app/card.ts'), 'data-testid="card-title"');
  expect(note.target?.source).toMatchObject({ file: 'src/app/card.ts', line, col: 7 });
  expect(note.target?.components?.slice(0, 2)).toEqual(['Card', 'App']);
});
