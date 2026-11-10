// Extension API v6 (D61): a target enricher adds what the host page knows about the picked element
// (here Optimizely's edit-mode `data-epi-property-name`) as `target.extra`, which reaches the markdown;
// `beforeCreate` can change the request or drop the note before the transport is called.
import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ui } from './helpers.ts';
import { commentOn, serve, type Served } from './serve.ts';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>CMS page</title>
<script>
  (window.redlineExtensions ||= []).push(rl => {
    window.rlVersion = rl.version;
    rl.addTargetEnricher(el => {
      const p = el.closest('[data-epi-property-name]');
      return p ? { extra: { epiProperty: p.getAttribute('data-epi-property-name'), depth: 1, skipped: { no: 1 } } } : undefined;
    });
    rl.addTargetEnricher((el, target) => { target.extra = { ...target.extra, block: Number(el.closest('[data-epi-block-id]')?.getAttribute('data-epi-block-id') ?? 0) }; });
    rl.on('beforeCreate', req => window.dropNext ? false : { ...req, note: { ...req.note, meta: { host: 'cms' } } });
  });
</script></head>
<body><main data-epi-property-name="MainBody"><section data-epi-block-id="117">
<h1>Hosted app</h1><button data-testid="save" onclick="window.clicked=(window.clicked||0)+1">Save draft</button>
</section></main></body></html>`;

let s: Served;
test.beforeEach(async ({ page }) => {
  s = await serve({ page: () => PAGE });
  await page.goto(s.url + '/');
});
test.afterEach(() => s.close());

test('an enricher copies the nearest data-epi-property-name into target.extra; the saved note carries it', async ({ page }) => {
  expect(await page.evaluate(() => (window as { rlVersion?: number }).rlVersion)).toBe(6);
  const note = await commentOn(page, 'Shorter label', '/__redline') as { target?: { extra?: unknown }; meta?: unknown };
  // Only primitives are kept; both enrichers' keys merged.
  expect(note.target?.extra).toEqual({ epiProperty: 'MainBody', depth: 1, block: 117 });
  expect(note.meta).toEqual({ host: 'cms' });   // beforeCreate changed the request
  const md = await fs.readFile(path.join(s.root, '.redline/pages/index.md'), 'utf8');
  expect(md).toContain('"extra":{"epiProperty":"MainBody","depth":1,"block":117}');
});

test('beforeCreate returning false saves nothing and closes the draft', async ({ page }) => {
  await page.evaluate(() => { (window as { dropNext?: boolean }).dropNext = true; });
  const posts: string[] = [];
  page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
  await expect(ui(page, '.launcher')).toBeAttached();
  await page.keyboard.press('Alt+Shift+KeyR');
  await page.keyboard.press('c');
  const b = (await page.getByTestId('save').boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(ui(page, '.pop textarea')).toBeFocused();
  await page.keyboard.type('Never saved');
  await page.keyboard.press('Control+Enter');
  await expect(ui(page, '.pop')).toHaveCount(0);
  await expect(ui(page, '.bar button.on')).toHaveCount(0);   // back to idle
  await page.waitForTimeout(500);
  expect(posts).toEqual([]);
  expect(await fs.stat(path.join(s.root, '.redline/pages/index.md')).then(() => true, () => false)).toBe(false);
  expect(await page.evaluate(() => (window as { clicked?: number }).clicked ?? 0)).toBe(0);
});
