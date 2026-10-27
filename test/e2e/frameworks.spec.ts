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
  { f: FIXTURES.next, file: 'app/page.tsx', components: ['Page', 'Card'] },
  { f: FIXTURES['next-turbo'], file: 'app/page.tsx', components: ['Page', 'Card'] },
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

// Next.js (D48): the button above is in a Server Component; these are a Client Component and the Pages Router.
for (const f of [FIXTURES.next, FIXTURES['next-turbo']]) {
  test(`${f.name}: a client component and a Pages Router page point at their files`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await resetNotes(f);
    await openOverlay(page, f);
    let note = await comment(page, page.getByTestId('client-action'), 'Count in tens.');
    expect(note.target?.source).toMatchObject({ file: 'components/Counter.tsx', line: await lineOf(path.join(f.dir, 'components/Counter.tsx'), 'data-testid="client-action"') });
    expect(note.target?.components?.slice(0, 2)).toEqual(['Counter', 'Card']);
    await page.getByTestId('client-action').evaluate(b => (b as HTMLButtonElement).click());
    await expect(page.getByTestId('client-action')).toHaveText('Clicked 1');   // hydrated, stamps and all
    expect(errors.filter(e => /hydrat|didn't match/i.test(e))).toEqual([]);

    const legacy = await page.context().newPage();   // a fresh tab: the overlay stays open per tab
    await openOverlay(legacy, f, '/legacy');
    note = await comment(legacy, legacy.getByTestId('legacy-title'), 'Rename.');
    expect(note.target?.source).toMatchObject({ file: 'pages/legacy.tsx', line: await lineOf(path.join(f.dir, 'pages/legacy.tsx'), 'data-testid="legacy-title"') });
    expect(note.target?.components?.[0]).toBe('Legacy');
  });
}
