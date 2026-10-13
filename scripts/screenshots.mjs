// Regenerates the README screenshots (docs/images/*.png) from the demo app in examples/demo.
//   npm run screenshots        (builds dist/ first)
// Starts the demo on its own Vite server, drives the overlay with Playwright, then stops it.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const demo = path.resolve('examples/demo');
const out = path.resolve('docs/images');
const notesFile = path.join(demo, '.redline/pages/index.md');

await fs.rm(path.join(demo, '.redline'), { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

const server = await createServer({ configFile: path.join(demo, 'vite.config.mjs'), server: { port: 5210, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM ? undefined : 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 700 }, deviceScaleFactor: 2 });
const ui = sel => page.locator('redline-root').locator(sel);
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const saved = () => page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST');
const centre = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
// Hover first, then click: the overlay picks the hovered element on pointerup.
const pick = async loc => { const [x, y] = await centre(loc); await page.mouse.move(x, y); await page.mouse.click(x, y); };
// Save with `key`, wait for the POST, and let the "Saved" toast clear before the next shot.
// The popover focuses its textarea a tick after it appears; typing earlier would hit the mode keys.
const typeNote = async text => {
  await page.waitForFunction(() => document.querySelector('redline-root')?.shadowRoot?.activeElement?.tagName === 'TEXTAREA');
  await page.keyboard.type(text);
};
const save = async key => { const r = saved(); await page.keyboard.press(key); await r; await ui('.toast').waitFor({ state: 'hidden' }); };

try {
  await page.goto('http://localhost:5210/', { waitUntil: 'networkidle' });
  await ui('.launcher').waitFor({ state: 'attached' });
  await page.keyboard.press('Alt+Shift+KeyR');
  await ui('.bar').waitFor();

  // 1. Comment on the primary button.
  await page.keyboard.press('c');
  await pick(page.getByTestId('new-route'));
  await typeNote('Make this the only purple button on the page, and add a "+" icon.');
  await shot('comment');
  await save('Control+Enter');

  // 2. Rewrite the lead text in place.
  await page.keyboard.press('t');
  await pick(page.locator('p.lead'));
  await ui('.ed').waitFor();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Every route, every driver, live. Updated every 30 seconds.');
  await page.keyboard.press('Enter');
  await ui('.pop .diff').waitFor();
  await shot('text');
  await save('Enter');

  // 3. Sketch: a box around the chart, an arrow and a label. Shot before the note popover covers it.
  await page.keyboard.press('s');
  const chart = await page.locator('.chart').boundingBox();
  await page.keyboard.press('1');
  await drag([chart.x - 6, chart.y - 6], [chart.x + chart.width + 6, chart.y + chart.height + 6]);
  await page.keyboard.press('2');
  await drag([chart.x - 150, chart.y + chart.height + 40], [chart.x - 12, chart.y + chart.height - 40]);
  await page.keyboard.press('4');
  await page.mouse.click(chart.x - 330, chart.y + chart.height + 62);
  await page.waitForFunction(() => document.querySelector('redline-root')?.shadowRoot?.activeElement?.tagName === 'INPUT');
  await page.keyboard.type('line chart + last week?');
  await page.keyboard.press('Enter');
  await page.mouse.move(chart.x + chart.width / 2, chart.y + 60);
  await shot('sketch');
  await page.keyboard.press('Enter');
  await typeNote('Switch this to a line chart with last week as a dashed comparison.');
  await save('Control+Enter');

  // 4. An agent ticks the first note off and replies, then the panel shows it live.
  const md = await fs.readFile(notesFile, 'utf8');
  await fs.writeFile(notesFile, md.replace(/^### \[ \]/m, '### [x]')
    .replace('add a "+" icon.\n', 'add a "+" icon.\n\n> Done: Export CSV is now a ghost button and New route has a plus icon (src/App.tsx:32).\n'));
  await page.keyboard.press('n');
  await ui('.filters label').filter({ hasText: 'Show done' }).click();
  await ui('.card .reply').waitFor();
  await shot('panel');
  console.log(`Wrote ${['comment', 'text', 'sketch', 'panel'].map(n => `docs/images/${n}.png`).join(', ')}`);
} finally {
  await browser.close();
  await server.close();
}

async function drag([x1, y1], [x2, y2]) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 8 });
  await page.mouse.up();
}
