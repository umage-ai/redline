import { expect, type Page, type Locator } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Note } from '../../src/shared/types.ts';
import type { Fixture } from './fixtures.ts';

export type SavedNote = Note & { file: string };

/** Overlay UI. Playwright's CSS locators pierce the open shadow root. */
export const ui = (page: Page, sel: string): Locator => page.locator('redline-root').locator(sel);

export async function resetNotes(f: Fixture) {
  await fs.rm(path.join(f.dir, '.redline'), { recursive: true, force: true });
}

export async function readPage(f: Fixture, slug = 'index'): Promise<string> {
  return fs.readFile(path.join(f.dir, '.redline/pages', `${slug}.md`), 'utf8');
}

export async function assetExists(f: Fixture, rel: string | undefined): Promise<boolean> {
  if (!rel) return false;
  return fs.stat(path.join(f.dir, '.redline/pages', rel)).then(() => true, () => false);
}

export async function openOverlay(page: Page, f: Fixture, route = '/') {
  // networkidle: SSR pages (SvelteKit) only get framework dev metadata once hydrated.
  await page.goto(f.url + route, { waitUntil: 'networkidle' });
  await expect(ui(page, '.launcher')).toBeAttached();
  await page.keyboard.press('Alt+Shift+KeyR');
  await expect(ui(page, '.bar')).toBeVisible();
}

/** Real mouse at the element centre: works for disabled controls, unlike locator.click(). */
export async function mouseAt(page: Page, target: Locator, click = true) {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x, y);
  if (click) await page.mouse.click(x, y);
}

export function waitForSave(page: Page): Promise<SavedNote> {
  return page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST')
    .then(r => r.json());
}

/** Comment mode → click target → type → Ctrl+Enter. Returns the saved note. */
export async function comment(page: Page, target: Locator, text: string): Promise<SavedNote> {
  if (!(await ui(page, '.bar button.on').filter({ hasText: 'Comment' }).count())) await page.keyboard.press('c');
  await mouseAt(page, target);
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type(text);
  const saved = waitForSave(page);
  await page.keyboard.press('Control+Enter');
  return saved;
}

export function lineOf(file: string, needle: string): Promise<number> {
  return fs.readFile(file, 'utf8').then(s => s.split(/\r?\n/).findIndex(l => l.includes(needle)) + 1);
}
