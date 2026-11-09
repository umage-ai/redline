// A scripted stand-in for an agent CLI, for the agent promo (promo/agent.mjs). It speaks like
// Claude Code where the panel can see it: it asks the terminal for OSC 7501 (with the DA1 sentinel),
// reports working / blocked (permission) / done, and draws Claude Code's edit menu (a rule, the diff,
// "❯ 1. Yes / 2. Yes, and don't ask again / 3. No", redrawn as the ❯ moves), so the toolbar's card
// shows it. Then it really applies the notes it was handed: it edits examples/demo/src/App.tsx (HMR
// shows it) and ticks each note off with a reply in .redline, the way skill/SKILL.md describes.
// It knows two notes (the button, the "Active routes" heading). The terminal lines are illustrative.
// PLAN_MS: how long it "plans" before asking (default 900).
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ESC = '\x1b', ST = ESC + '\\';
const out = s => process.stdout.write(s);
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
let supported = false, probing = true, line = '', menu = null;
const report = f => { if (supported) out(`${ESC}]7501;${f}:app=demo-agent${ST}`); };
const dim = s => `${ESC}[2m${s}${ESC}[22m`, bold = s => `${ESC}[1m${s}${ESC}[22m`, accent = s => `${ESC}[38;5;209m${s}${ESC}[39m`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PLAN = Number(process.env.PLAN_MS ?? 900);

const APP = path.resolve('src/App.tsx');
const NOTES = path.resolve('.redline/pages/index.md');
// What it does for each note it knows, recognised by the note's text.
const EDITS = [
  { when: /Plan a route/i, line: 35, from: '>New route</button>', to: '>+ Plan a route</button>', show: ['<button>New route</button>', '<button>+ Plan a route</button>'], reply: 'added a + and renamed it "Plan a route"' },
  { when: /Routes today/i, line: 84, from: '<h2>Active routes</h2>', to: '<h2>Routes today</h2>', show: ['<h2>Active routes</h2>', '<h2>Routes today</h2>'], reply: 'renamed the heading to "Routes today"' },
];
const OPTIONS = ['Yes', "Yes, and don't ask again this session", 'No'];

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
out(`${accent('✻')} ${bold('Welcome to the demo agent')}\r\n${dim('  cwd: examples/demo')}\r\n\r\n`);
out(`${ESC}]7501;?${ST}${ESC}[c`);
const giveUp = setTimeout(() => { probing = false; ready(); }, 3000);
function ready() { out(`${ESC}[?2004h> `); report('state=idle'); }

/** The notes the prompt named, with what to do for each. */
async function notesFor(prompt) {
  const md = await fs.readFile(NOTES, 'utf8');
  return md.split(/^(?=### )/m).flatMap(sec => {
    const id = /"id":"([^"]+)"/.exec(sec)?.[1];
    const edit = id && prompt.includes(id) ? EDITS.find(e => e.when.test(sec)) : undefined;
    return edit ? [{ id, edit }] : [];
  });
}

function drawOptions(first) {
  if (!first) out(`${ESC}[${OPTIONS.length + 2}A`);
  OPTIONS.forEach((o, i) => out(`\r${ESC}[2K${i === menu.cursor ? ` ${accent('❯')}` : '  '} ${i + 1}. ${o}\r\n`));
  out(`\r${ESC}[2K\r\n\r${ESC}[2K ${dim('Esc to cancel · Tab to amend')}\r\n`);
}

async function run(prompt) {
  out('\r\n\r\n');   // the prompt was echoed as it was typed
  report(`state=working:msg=${b64('reading the notes')}`);
  const todo = await notesFor(prompt);
  await sleep(700);
  out(`${accent('●')} redline · list_notes ${dim(`→ ${todo.length} note${todo.length === 1 ? '' : 's'} for this session`)}\r\n`);
  await sleep(700);
  out(`${accent('●')} redline · get_note ${dim('(with the screenshot)')}\r\n`);
  report(`state=working:msg=${b64('planning the edit')}`);
  await sleep(PLAN);
  for (const { id, edit } of todo) {
    out(`\r\n${'─'.repeat(72)}\r\n ${bold('Edit file')}\r\n src/App.tsx\r\n${'╌'.repeat(72)}\r\n`);
    out(`${ESC}[48;2;80;20;30m ${edit.line} -  ${edit.show[0]} ${ESC}[0m\r\n${ESC}[48;2;20;70;40m ${edit.line} +  ${edit.show[1]} ${ESC}[0m\r\n${'╌'.repeat(72)}\r\n`);
    out(` Do you want to make this edit to ${bold('src/App.tsx')}?\r\n`);
    menu = { cursor: 0 };
    drawOptions(true);
    report(`state=blocked:kind=permission:msg=${b64('Edit src/App.tsx?')}`);
    const pick = await new Promise(r => { menu.done = r; });
    menu = null;
    if (pick === 2 || pick < 0) { out(`\r\n${dim('Edit declined.')}\r\n> `); report(`state=done:msg=${b64('edit declined')}`); return; }
    report(`state=working:msg=${b64('editing src/App.tsx')}`);
    await fs.writeFile(APP, (await fs.readFile(APP, 'utf8')).replace(edit.from, edit.to));
    out(`\r\n${accent('●')} Updated src/App.tsx ${dim('(1 line)')}\r\n`);
    await sleep(700);
    const md = await fs.readFile(NOTES, 'utf8');
    await fs.writeFile(NOTES, md.split(/^(?=### )/m).map(sec => sec.includes(`"id":"${id}"`)
      ? sec.replace(/^### \[ \]/, '### [x]').trimEnd() + `\n> Done: ${edit.reply} (src/App.tsx:${edit.line}).\n\n` : sec).join(''));
    out(`${accent('●')} redline · update_note ${dim('→ ticked off, with a reply')}\r\n`);
  }
  out('\r\n> ');
  report(`state=done:msg=${b64(`applied ${todo.length} note${todo.length === 1 ? '' : 's'}`)}`);
}

const KEYS = [['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', ''], ['\x1b[D', ''], ['\x1b[200~', ''], ['\x1b[201~', ''], ['\r', 'enter'], ['\x7f', 'back'], ['\x1b', 'esc']];
process.stdin.on('data', chunk => {
  let s = chunk;
  if (probing) {
    const osc = s.indexOf(`${ESC}]7501;?`), da = s.search(/\x1b\[\?[\d;]*c/);
    if (osc >= 0 && (da < 0 || osc < da)) supported = true;
    if (da >= 0) { probing = false; clearTimeout(giveUp); ready(); }
    s = s.replace(/\x1b\]7501;\?(\x07|\x1b\\)/g, '').replace(/\x1b\[\?[\d;]*c/g, '');
  }
  while (s) {
    const hit = KEYS.find(([seq]) => s.startsWith(seq));
    const [seq, k] = hit ?? [s[0], s[0]];
    s = s.slice(seq.length);
    if (!k) continue;
    if (menu) {
      if (k === 'up' || k === 'down') { menu.cursor = (menu.cursor + (k === 'up' ? OPTIONS.length - 1 : 1)) % OPTIONS.length; drawOptions(false); }
      else if (k === 'enter') menu.done(menu.cursor);
      else if (k === 'esc') menu.done(-1);
      else if (/^[1-3]$/.test(k)) menu.done(Number(k) - 1);
      continue;
    }
    if (k === 'enter') { const p = line.trim(); line = ''; if (p) void run(p); else out('\r\n> '); }
    else if (k === 'back') { if (line) { line = line.slice(0, -1); out('\b \b'); } }
    else if (k.length === 1 && k >= ' ') { line += k; out(k); }
  }
});
