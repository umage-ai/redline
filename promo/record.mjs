// Records the promo video (silent, H.264) from the demo app. Spec and storyboard: promo/README.md.
//   npm run promo                    → promo/out/redline-promo.mp4 and redline-promo-poster.png (1080×1350, LinkedIn)
//   PROMO_FORMAT=web npm run promo   → promo/out/redline-promo-web.mp4 and its poster (1920×1080, web pages)
//   PROMO_HEADED=1 npm run promo     to watch it record
// Two pages are recorded side by side: the demo app (1360×880) and promo/stage.html (1440×1800: caption, browser frame,
// markdown/terminal panel). Redline never runs inside an iframe, so ffmpeg composites the app onto the stage instead.
// Frames come from CDP screencasts with their timestamps, which keeps real-time pacing and lines the two pages up.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// ---------- storyboard (keep in step with the table in promo/README.md) ----------
const S = {
  open: { step: '01 · Open', title: 'Press a hotkey in your<br>running dev app.', keys: ['Alt', 'Shift', 'R'] },
  comment: { step: '02 · Comment', title: 'Click any element, pick a label,<br>say what you want.', keys: ['C'] },
  commentSaved: { step: '02 · Comment', title: 'Saved as markdown, with the selector,<br>source file:line and a screenshot.' },
  text: { step: '03 · Text', title: 'Rewrite copy<br>right on the page.', keys: ['T'] },
  textApplied: { step: '03 · Text', title: 'Static copy? Written straight<br>into the source file.' },
  sketch: { step: '04 · Sketch', title: 'Draw boxes, arrows<br>and labels on the page.', keys: ['S'] },
  agent: { step: '05 · Agent', title: 'Your AI agent picks up<br>the notes over MCP.' },
  done: { step: '05 · Agent', title: 'Ticked off, with replies,<br>live in the overlay.' },
};
const COMMENT = 'Add a "+" icon and call it "Plan a route".';
const LEAD = 'Every route, every driver, live. Updated every 30 seconds.';
const SKETCH_LABEL = 'line chart + last week?';
const SKETCH_NOTE = 'Switch to a line chart, with last week as a comparison.';
// What the "agent" does, one entry per note in order (the text edit was applied to the file, so it leaves no note):
// a real edit to the demo source (HMR shows it) or none, a line for the terminal, and the reply written under the
// note. The source file is restored afterwards.
const AGENT = [
  { from: '>New route</button>', to: '>+ Plan a route</button>', log: '✓ Added a + icon and renamed it', reply: 'Done: added a + icon and renamed it (src/App.tsx:32).' },
  { log: '? Asked: dashed line or lighter colour for last week?', reply: 'Question: dashed line or a lighter colour for last week?' },
];
const TYPE_DELAY = 38;   // ms per typed character

// Formats: the stage size, where the app sits on it (stage.html's .hole), and the encoded size.
const FORMATS = {
  feed: { stage: [1440, 1800], app: [40, 330], out: [1080, 1350], name: 'redline-promo', query: '' },
  web: { stage: [2400, 1350], app: [1000, 315], out: [1920, 1080], name: 'redline-promo-web', query: '?format=web' },
};
const F = FORMATS[process.env.PROMO_FORMAT ?? 'feed'];
if (!F) throw new Error(`PROMO_FORMAT must be one of: ${Object.keys(FORMATS).join(', ')}`);

// ---------- setup ----------
const demo = path.resolve('examples/demo');
const outDir = path.resolve('promo/out');
const framesDir = path.join(outDir, 'frames');
const notesFile = path.join(demo, '.redline/pages/index.md');
const appFile = path.join(demo, 'src/App.tsx');
const PORT = Number(process.env.PROMO_PORT ?? 5211);   // the .NET samples use 5210/5211 too

await fs.rm(path.join(demo, '.redline'), { recursive: true, force: true });
await fs.rm(framesDir, { recursive: true, force: true });
await fs.mkdir(framesDir, { recursive: true });
const appSource = await fs.readFile(appFile, 'utf8');

const server = await createServer({ configFile: path.join(demo, 'vite.config.mjs'), server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ channel: process.env.PW_CHROMIUM ? undefined : 'chrome', headless: !process.env.PROMO_HEADED });
const stagePage = await browser.newPage({ viewport: { width: F.stage[0], height: F.stage[1] }, deviceScaleFactor: 1 });
const page = await browser.newPage({ viewport: { width: 1360, height: 760 }, deviceScaleFactor: 1 });
await page.addInitScript(fakeCursor);
// The demo's own overlay extension (a Copy list button) isn't part of Redline; keep it out of the video.
await page.route('**/__redline/ext/**', r => r.fulfill({ contentType: 'text/javascript', body: '' }));

const ui = sel => page.locator('redline-root').locator(sel);
const stage = (fn, ...args) => stagePage.evaluate(([fn, args]) => window.stage[fn](...args), [fn, args]);
const caption = s => stage('caption', s.step, s.title, s.keys ?? []);
const hold = ms => page.waitForTimeout(ms);
const centre = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

let cursor = [680, 600];
// Eased mouse move at a watchable speed (page.mouse.move with steps is instant).
async function glide([x, y], ms = 650) {
  const [x0, y0] = cursor, n = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await hold(16);
  }
  cursor = [x, y];
}
// Hover first, then click: the overlay picks the hovered element on pointerup.
const pick = async loc => { await glide(await centre(loc)); await hold(350); await page.mouse.click(...cursor); };
async function drag(from, to) {
  await glide(from, 450);
  await page.mouse.down();
  await glide(to, 700);
  await page.mouse.up();
}
const typeSlow = text => page.keyboard.type(text, { delay: TYPE_DELAY });
// The popover focuses its field a tick after it appears; typing earlier would hit the mode keys.
const focused = tag => page.waitForFunction(t => document.querySelector('redline-root')?.shadowRoot?.activeElement?.tagName === t, tag);
async function save(key) {
  const r = page.waitForResponse(r => r.url().endsWith('/__redline/notes') && r.request().method() === 'POST');
  await page.keyboard.press(key);
  await r;
  await showNotes();
}
// Shows the notes file in the stage panel from its first note (the preamble is for agents), highlighting `fresh`
// line indexes (default: the last note, as new ones are appended).
async function showNotes(fresh) {
  const file = (await fs.readFile(notesFile, 'utf8')).trimEnd();
  const md = file.slice(file.search(/^### /m));
  const lines = md.split('\n');
  const last = lines.findLastIndex(l => l.startsWith('### '));
  await stage('markdown', md, fresh ?? lines.map((_, i) => i).filter(i => i >= last));
}

// Shows what Apply to file changed in App.tsx as a diff in the stage panel.
async function showSourceDiff() {
  const before = appSource.split('\n'), after = (await fs.readFile(appFile, 'utf8')).split('\n');
  const i = after.findIndex((l, j) => l !== before[j]);
  if (i < 0) return;
  const ctx = (a, b) => after.slice(a, b).map(l => '  ' + l.trim());
  await stage('code', `src/App.tsx:${i + 1}`, '· written by Apply to file', [...ctx(Math.max(0, i - 2), i), '- ' + before[i].trim(), '+ ' + after[i].trim(), ...ctx(i + 1, i + 3)]);
}

// ---------- recording ----------
async function screencast(p, name) {
  const frames = [], writes = [], cdp = await p.context().newCDPSession(p);
  await fs.mkdir(path.join(framesDir, name));
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const file = path.join(framesDir, name, `${String(frames.length).padStart(5, '0')}.jpg`);
    frames.push({ file, ts: metadata.timestamp });
    writes.push(fs.writeFile(file, Buffer.from(data, 'base64')));
  });
  return {
    frames, writes,
    start: () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 }),
    stop: () => cdp.send('Page.stopScreencast'),
  };
}
const stageRec = await screencast(stagePage, 'stage');
const appRec = await screencast(page, 'app');
const now = () => Date.now() / 1000;
let t0, appIn, appOut, end;   // recording start; then (s from t0) title card leaves, end card arrives, recording stops

try {
  await stagePage.goto(pathToFileURL(path.resolve('promo/stage.html')).href + F.query);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await ui('.launcher').waitFor({ state: 'attached' });
  await page.mouse.move(...cursor);
  await stage('markdown', '# Redline notes\n\n(no notes yet)', []);
  await stage('card', 'title');
  await hold(600);
  t0 = now();
  await Promise.all([stageRec.start(), appRec.start()]);

  // 00 · title card
  await hold(2800);
  appIn = now() - t0;
  await stage('card', null);

  // 01 · open the overlay
  await caption(S.open);
  await glide(await centre(page.locator('h1')), 900);
  await hold(800);
  await page.keyboard.press('Alt+Shift+KeyR');
  await ui('.bar').waitFor();
  await hold(1200);

  // 02 · comment on the primary button
  await caption(S.comment);
  await hold(700);
  await page.keyboard.press('c');
  await pick(page.getByTestId('new-route'));
  await focused('TEXTAREA');
  await hold(400);
  await pick(ui('.pop .chip').filter({ hasText: 'UX' }));   // label the note (D46)
  await hold(500);
  await typeSlow(COMMENT);
  await hold(900);
  await save('Control+Enter');
  await caption(S.commentSaved);
  await hold(2700);

  // 03 · rewrite the lead text in place
  await caption(S.text);
  await hold(600);
  await page.keyboard.press('t');
  await pick(page.locator('p.lead'));
  await ui('.ed').waitFor();
  await page.keyboard.press('Control+A');
  await typeSlow(LEAD);
  await hold(500);
  await page.keyboard.press('Enter');
  await ui('.pop .diff').waitFor();
  await ui('.pop .btn.apply:enabled').waitFor();
  await hold(900);
  const wrote = page.waitForResponse(r => r.url().endsWith('/__redline/edit') && r.request().method() === 'POST');
  await pick(ui('.pop .btn.apply'));
  await wrote;
  await showSourceDiff();
  await caption(S.textApplied);
  await hold(3000);

  // 04 · sketch on the chart
  await caption(S.sketch);
  await hold(600);
  await page.keyboard.press('s');
  const chart = await page.locator('.chart').boundingBox();
  await page.keyboard.press('1');
  await drag([chart.x - 6, chart.y - 6], [chart.x + chart.width + 6, chart.y + chart.height + 6]);
  await page.keyboard.press('2');
  await drag([chart.x - 150, chart.y + chart.height + 40], [chart.x - 12, chart.y + chart.height - 40]);
  await page.keyboard.press('4');
  await glide([chart.x - 330, chart.y + chart.height + 62], 500);
  await page.mouse.click(...cursor);
  await focused('INPUT');
  await typeSlow(SKETCH_LABEL);
  await page.keyboard.press('Enter');
  await hold(1200);
  await page.keyboard.press('Enter');
  await focused('TEXTAREA');
  await typeSlow(SKETCH_NOTE);
  await hold(700);
  await save('Control+Enter');
  await hold(1800);

  // 05 · the agent applies the notes
  await caption(S.agent);
  const headings = (await fs.readFile(notesFile, 'utf8')).split('\n').filter(l => l.startsWith('### ')).map(l => l.slice(8));
  const term = ['$ claude "apply the redline notes"', '', `redline · list_notes → ${headings.length} open notes on /`];
  await stage('terminal', term);
  await hold(1400);
  for (const [i, h] of headings.entries()) {
    term.push('', `● ${h}`, '  redline · get_note (with the screenshot)');
    await stage('terminal', term);
    await hold(900);
    const step = AGENT[i];
    if (step?.from) await fs.writeFile(appFile, (await fs.readFile(appFile, 'utf8')).replace(step.from, step.to));
    if (step) term.push(`  ${step.log}`, '  redline · update_note');
    await stage('terminal', term);
    await hold(1000);
  }
  // Tick off and reply in the notes file, the way skill/SKILL.md tells the agent to.
  let n = 0;
  const md = (await fs.readFile(notesFile, 'utf8')).split(/^(?=### )/m).map(b => {
    if (!b.startsWith('### ')) return b;
    const step = AGENT[n++];
    if (!step) return b;
    return (step.from ? b.replace('### [ ]', '### [x]') : b).trimEnd() + `\n\n> ${step.reply}\n\n`;
  }).join('').trimEnd() + '\n';
  await fs.writeFile(notesFile, md);
  await showNotes(md.slice(md.search(/^### /m)).split('\n').map((l, i) => (/^### \[x\]|^> /.test(l) ? i : -1)).filter(i => i >= 0));
  await hold(1500);

  // The overlay picks the replies up on its next poll; open the panel to show them.
  await caption(S.done);
  await page.keyboard.press('n');
  await ui('.filters label').filter({ hasText: 'Show done' }).click();
  await ui('.card .reply').first().waitFor();
  await hold(3800);

  // 06 · end card
  appOut = now() - t0;
  await stage('card', 'end');
  await hold(4000);
  await Promise.all([stageRec.stop(), appRec.stop()]);
  end = now() - t0;
} finally {
  await fs.writeFile(appFile, appSource);
  await browser.close();
  await server.close();
}

// ---------- encode ----------
await Promise.all([...stageRec.writes, ...appRec.writes]);
// One concat list per page, timed from t0 so both streams share a clock. A page only sends a frame when it changes.
async function concatList(frames, name) {
  const at = f => Math.max(0, f.ts - t0);
  const entry = f => `file '${f.file.replace(/\\/g, '/')}'`;
  const lines = frames.map((f, i) => `${entry(f)}\nduration ${((i + 1 < frames.length ? at(frames[i + 1]) : end) - (i ? at(f) : 0)).toFixed(4)}`);
  lines.push(entry(frames.at(-1)));   // the concat demuxer needs the last file repeated
  const file = path.join(outDir, `${name}.txt`);
  await fs.writeFile(file, lines.join('\n'));
  return file;
}
const fade = 0.4;
const mp4 = path.join(outDir, `${F.name}.mp4`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'concat', '-safe', '0', '-i', await concatList(stageRec.frames, 'stage'),
  '-f', 'concat', '-safe', '0', '-i', await concatList(appRec.frames, 'app'),
  '-filter_complex', [
    '[0:v]fps=30,setpts=PTS-STARTPTS[bg]',
    `[1:v]fps=30,setpts=PTS-STARTPTS,format=yuva420p,fade=t=in:st=${appIn.toFixed(3)}:d=${fade}:alpha=1,fade=t=out:st=${appOut.toFixed(3)}:d=${fade}:alpha=1[fg]`,
    `[bg][fg]overlay=${F.app[0]}:${F.app[1]}:eof_action=repeat,scale=${F.out[0]}:${F.out[1]}:flags=lanczos:out_range=tv,format=yuv420p[v]`,
  ].join(';'),
  '-map', '[v]', '-t', end.toFixed(3), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', '-an', mp4], { stdio: 'inherit' });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1.5', '-i', mp4, '-frames:v', '1', path.join(outDir, `${F.name}-poster.png`)], { stdio: 'inherit' });
console.log(`Wrote ${path.relative('.', mp4)} (${end.toFixed(1)} s; ${stageRec.frames.length} stage + ${appRec.frames.length} app frames) and its poster.`);

// Draws a cursor and a click ripple in the demo app, since a screencast has no pointer.
function fakeCursor() {
  if (window.top !== window) return;
  const add = () => {
    const c = document.createElement('div');
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 10.5-7 1.3-3.6 6.7z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))';
    const keepLast = () => { if (document.documentElement.lastElementChild !== c) document.documentElement.append(c); };
    keepLast();
    new MutationObserver(keepLast).observe(document.documentElement, { childList: true });
    addEventListener('mousemove', e => { c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', e => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${e.clientX - 22}px;top:${e.clientY - 22}px;width:44px;height:44px;border-radius:50%;
        border:3px solid #ff2d55;z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out`;
      document.documentElement.append(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.6)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.documentElement) add(); else addEventListener('DOMContentLoaded', add);
}
