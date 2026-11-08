// Records the short agent-toolbar promo (silent, H.264, 1920×1200) from the demo app:
//   npm run promo:agent   → promo/out/redline-agent.mp4 and redline-agent-poster.png
// The overlay, the agent toolbar, the Allow click and the HMR edit are all real; the agent CLI is a scripted
// stand-in (promo/demo-agent.mjs) that reports OSC 7501 like Claude Code, asks before its edit, then edits
// App.tsx and ticks the note off. One page, recorded with a CDP screencast; captions are drawn into the page.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import redline from '../dist/vite.js';

const demo = path.resolve('examples/demo');
const outDir = path.resolve('promo/out');
const framesDir = path.join(outDir, 'agent-frames');
const appFile = path.join(demo, 'src/App.tsx');
const PORT = Number(process.env.PROMO_PORT ?? 5212);
const COMMENT = 'Add a "+" and call it "Plan a route".';

await fs.rm(path.join(demo, '.redline'), { recursive: true, force: true });
await fs.rm(framesDir, { recursive: true, force: true });
await fs.mkdir(framesDir, { recursive: true });
const appSource = await fs.readFile(appFile, 'utf8');

const server = await createServer({
  configFile: false, root: demo, cacheDir: path.join(demo, '.vite-cache'), logLevel: 'warn',
  server: { port: PORT, strictPort: true },
  plugins: [redline({ root: demo, agent: { command: process.execPath, args: [path.resolve('promo/demo-agent.mjs')], label: 'claude' } }), react()],
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
});
await server.listen();
const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM ? undefined : 'chrome', headless: !process.env.PROMO_HEADED });
const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1.875 });
await page.addInitScript(stageScript);
const ui = sel => page.locator('redline-root').locator(sel);
const hold = ms => page.waitForTimeout(ms);
const caption = (step, title, keys = []) => page.evaluate(([s, t, k]) => window.__stage.caption(s, t, k), [step, title, keys]);
const card = (kind) => page.evaluate(k => window.__stage.card(k), kind);
const centre = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
let cursor = [512, 400];
async function glide([x, y], ms = 650) {
  const [x0, y0] = cursor, n = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await hold(16);
  }
  cursor = [x, y];
}
const click = async loc => { await glide(await centre(loc)); await hold(300); await page.mouse.click(...cursor); };

// CDP screencast with timestamps: real-time pacing (a frame only comes when the page changes).
const cdp = await page.context().newCDPSession(page);
const frames = [], writes = [];
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  const file = path.join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
  frames.push({ file, ts: metadata.timestamp });
  writes.push(fs.writeFile(file, Buffer.from(data, 'base64')));
});
let t0, end;
const info = async () => (await fetch(`http://localhost:${PORT}/__redline/agent/info`)).json();

try {
  const { token } = await info();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await ui('.launcher').waitFor({ state: 'attached' });
  await page.mouse.move(...cursor);
  await card('title');
  await hold(500);
  t0 = Date.now() / 1000;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  await hold(2600);
  await card(null);

  // 1 · a note
  await caption('01 · Note', 'Pin a note on your running app.', ['Alt', 'Shift', 'R']);
  await hold(600);
  await page.keyboard.press('Alt+Shift+KeyR');
  await ui('.bar').waitFor();
  await hold(500);
  await page.keyboard.press('c');
  await click(page.getByTestId('new-route'));
  await page.waitForFunction(() => document.querySelector('redline-root')?.shadowRoot?.activeElement?.tagName === 'TEXTAREA');
  await page.keyboard.type(COMMENT, { delay: 34 });
  await hold(500);
  const saved = page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST');
  await page.keyboard.press('Control+Enter');
  await saved;
  await hold(1200);

  // 2 · the agent toolbar
  await caption('02 · Agent', 'Press A: everything for your agent, in one toolbar.', ['A']);
  await hold(700);
  await page.keyboard.press('a');
  await ui('.bar.ext').waitFor();
  await hold(2200);

  // 3 · apply, no terminal
  await caption('03 · Apply', 'Your agent CLI starts in the background.<br>No terminal needed.');
  await click(ui('.xbar button[data-cmd="Apply notes"]'));
  await ui('.bar.lit.spin').waitFor({ timeout: 20_000 });
  await glide([512, 330], 600);
  await hold(1500);

  // 4 · approval
  await ui('.xbar button.ag-allow').waitFor({ timeout: 20_000 });
  await caption('04 · Approve', 'It asks before it edits.<br>Allow, right in the toolbar.');
  await hold(1600);
  await click(ui('.xbar button.ag-allow'));
  await page.getByTestId('new-route').filter({ hasText: 'Plan a route' }).waitFor({ timeout: 20_000 });
  await ui('.xbar .ag-chip[data-state="done"]').waitFor();
  await caption('05 · Done', 'Applied live, the note ticked off.');
  await glide(await centre(page.getByTestId('new-route')), 700);
  await hold(1600);
  await page.keyboard.press('n');
  await ui('.filters label').filter({ hasText: 'Show done' }).click();
  await ui('.card .ag-tag.done').waitFor({ timeout: 10_000 });
  await glide(await centre(ui('.card .ag-tag.done')), 700);
  await hold(2200);

  // 5 · the terminal, on demand
  await caption('06 · CLI', 'The terminal is one click away.');
  await page.keyboard.press('n');
  await click(ui('.xbar button[data-cli]'));
  await page.frameLocator('iframe[title$="terminal"]').locator('.xterm-rows').filter({ hasText: 'update_note' }).waitFor();
  await hold(2600);
  await click(ui('.xbar button[data-cli]'));   // the window sits above the page: close it before the end card
  await hold(400);

  await card('end');
  await hold(3600);
  await cdp.send('Page.stopScreencast');
  end = Date.now() / 1000 - t0;
  await fetch(`http://localhost:${PORT}/__redline/agent/stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': token }, body: '{}' }).catch(() => {});
} finally {
  await fs.writeFile(appFile, appSource);
  await browser.close();
  await server.close();
}

await Promise.all(writes);
const at = f => Math.max(0, f.ts - t0);
const entry = f => `file '${f.file.replace(/\\/g, '/')}'`;
const list = frames.map((f, i) => `${entry(f)}\nduration ${((i + 1 < frames.length ? at(frames[i + 1]) : end) - (i ? at(f) : 0)).toFixed(4)}`);
list.push(entry(frames.at(-1)));
const listFile = path.join(outDir, 'agent-frames.txt');
await fs.writeFile(listFile, list.join('\n'));
const mp4 = path.join(outDir, 'redline-agent.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-vf', 'fps=30,scale=1920:1200:flags=lanczos,format=yuv420p', '-t', end.toFixed(3),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', '-an', mp4], { stdio: 'inherit' });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.2', '-i', mp4, '-frames:v', '1', path.join(outDir, 'redline-agent-poster.png')], { stdio: 'inherit' });
console.log(`Wrote ${path.relative('.', mp4)} (${end.toFixed(1)} s, ${frames.length} frames).`);

// In the page: a cursor with a click ripple (a screencast has no pointer), the caption, and title/end cards.
function stageScript() {
  if (window.top !== window) return;
  const add = () => {
    const root = document.documentElement;
    const css = document.createElement('style');
    css.textContent = `
      .pr-cap { position: fixed; left: 50%; top: 18px; transform: translateX(-50%); z-index: 2147483640; pointer-events: none;
        background: rgba(19,19,22,.92); color: #ececf1; border-radius: 14px; padding: 12px 20px 14px; font: 600 22px/1.3 ui-sans-serif, system-ui, sans-serif;
        box-shadow: 0 10px 30px rgba(0,0,0,.25); text-align: center; transition: opacity .25s; min-width: 420px; }
      .pr-cap small { display: block; font: 700 12px/1 ui-monospace, Consolas, monospace; letter-spacing: .08em; color: #ff6b85; margin-bottom: 7px; text-transform: uppercase; }
      .pr-cap kbd { display: inline-block; font: 600 14px ui-monospace, Consolas, monospace; background: #26262d; border: 1px solid #3a3a46; border-bottom-width: 3px; border-radius: 6px; padding: 2px 8px; margin: 8px 3px 0; }
      .pr-card { position: fixed; inset: 0; z-index: 2147483645; display: grid; place-content: center; text-align: center; gap: 16px; background: #131316; color: #ececf1;
        font: 500 26px/1.35 ui-sans-serif, system-ui, sans-serif; transition: opacity .4s; }
      .pr-card h1 { margin: 0; font-size: 64px; font-weight: 800; letter-spacing: -.02em; } .pr-card h1 span { color: #ff2d55; }
      .pr-card code { font: 600 24px ui-monospace, Consolas, monospace; background: #26262d; padding: 8px 16px; border-radius: 10px; }
      .pr-card p { margin: 0; color: #a3a3ad; }`;
    root.append(css);
    const cap = document.createElement('div'); cap.className = 'pr-cap'; cap.style.opacity = '0'; root.append(cap);
    const cardEl = document.createElement('div'); cardEl.className = 'pr-card'; cardEl.style.opacity = '0'; cardEl.style.pointerEvents = 'none'; root.append(cardEl);
    const c = document.createElement('div');
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 10.5-7 1.3-3.6 6.7z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))';
    root.append(c);
    const keepLast = () => { for (const n of [cap, cardEl, c]) if (n.parentNode !== root || root.lastElementChild !== c) root.append(n); };
    new MutationObserver(() => { if (root.lastElementChild !== c) keepLast(); }).observe(root, { childList: true });
    addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', e => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #ff2d55;z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out`;
      root.append(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.6)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
    window.__stage = {
      caption(step, title, keys) {
        cap.innerHTML = `<small>${step}</small>${title}${keys.length ? `<div>${keys.map(k => `<kbd>${k}</kbd>`).join('')}</div>` : ''}`;
        cap.style.opacity = '1';
      },
      card(kind) {
        if (!kind) { cardEl.style.opacity = '0'; return; }
        cap.style.opacity = '0';
        const overlay = document.querySelector('redline-root');
        if (overlay && kind === 'end') overlay.style.visibility = 'hidden';   // it sits above everything
        cardEl.innerHTML = kind === 'title'
          ? '<h1>Red<span>line</span> · Agent</h1><p>Hand your notes to your AI agent.<br>No terminal needed.</p>'
          : '<h1>Red<span>line</span></h1><code>redline({ agent: true })</code><p>Your own agent CLI · live status from Claude Code<br>github.com/umage-ai/redline</p>';
        cardEl.style.opacity = '1';
      },
    };
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
}
