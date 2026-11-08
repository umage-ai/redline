// A scripted stand-in for an agent CLI, for the agent promo (promo/agent.mjs). It speaks like
// Claude Code where the panel can see it: it asks the terminal for OSC 7501 (with the DA1 sentinel),
// reports working / blocked (permission) / done, waits for Enter (Allow) or Esc (Deny), and then
// really applies the note: it edits examples/demo/src/App.tsx (HMR shows it) and ticks the note
// off with a reply in .redline, the way skill/SKILL.md describes. The terminal lines are illustrative.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ESC = '\x1b', ST = ESC + '\\';
const out = s => process.stdout.write(s);
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
let supported = false, probing = true, line = '', waiting = null;
const report = f => { if (supported) out(`${ESC}]7501;${f}:app=demo-agent${ST}`); };
const dim = s => `${ESC}[2m${s}${ESC}[22m`, bold = s => `${ESC}[1m${s}${ESC}[22m`, accent = s => `${ESC}[38;5;209m${s}${ESC}[39m`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const APP = path.resolve('src/App.tsx');
const NOTES = path.resolve('.redline/pages/index.md');
const FROM = '>New route</button>', TO = '>+ Plan a route</button>';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
out(`${accent('✻')} ${bold('Welcome to the demo agent')}\r\n${dim('  cwd: examples/demo')}\r\n\r\n`);
out(`${ESC}]7501;?${ST}${ESC}[c`);
const giveUp = setTimeout(() => { probing = false; ready(); }, 3000);
function ready() { out(`${ESC}[?2004h> `); report('state=idle'); }

async function run(prompt) {
  out('\r\n\r\n');   // the prompt was echoed as it was typed
  report(`state=working:msg=${b64('reading the notes')}`);
  await sleep(700);
  out(`${accent('●')} redline · list_notes ${dim('→ 1 open note on /')}\r\n`);
  await sleep(700);
  out(`${accent('●')} redline · get_note ${dim('(with the screenshot)')}\r\n`);
  report(`state=working:msg=${b64('planning the edit')}`);
  await sleep(900);
  out(`\r\n${bold('Edit src/App.tsx')}\r\n  ${ESC}[31m- <button className="primary">New route</button>${ESC}[39m\r\n  ${ESC}[32m+ <button className="primary">+ Plan a route</button>${ESC}[39m\r\n\r\n`);
  out(`Do you want to make this edit?\r\n ${accent('❯')} 1. Yes\r\n   2. No ${dim('(esc)')}\r\n`);
  report(`state=blocked:kind=permission:msg=${b64('Edit src/App.tsx?')}`);
  const ok = await new Promise(r => { waiting = r; });
  if (!ok) { out(`\r\n${dim('Edit declined.')}\r\n> `); report(`state=done:msg=${b64('edit declined')}`); return; }
  report(`state=working:msg=${b64('editing src/App.tsx')}`);
  await fs.writeFile(APP, (await fs.readFile(APP, 'utf8')).replace(FROM, TO));
  out(`\r\n${accent('●')} Updated src/App.tsx ${dim('(1 line)')}\r\n`);
  await sleep(800);
  const md = await fs.readFile(NOTES, 'utf8');
  await fs.writeFile(NOTES, md.replace(/^### \[ \](.*)$/m, '### [x]$1').trimEnd() + '\n\n> Done: added a + and renamed it "Plan a route" (src/App.tsx:35).\n');
  out(`${accent('●')} redline · update_note ${dim('→ ticked off, with a reply')}\r\n\r\n> `);
  report(`state=done:msg=${b64('applied 1 note')}`);
}

process.stdin.on('data', chunk => {
  let s = chunk;
  if (probing) {
    const osc = s.indexOf(`${ESC}]7501;?`), da = s.search(/\x1b\[\?[\d;]*c/);
    if (osc >= 0 && (da < 0 || osc < da)) supported = true;
    if (da >= 0) { probing = false; clearTimeout(giveUp); ready(); }
    s = s.replace(/\x1b\]7501;\?(\x07|\x1b\\)/g, '').replace(/\x1b\[\?[\d;]*c/g, '');
  }
  s = s.replace(/\x1b\[20[01]~/g, '');
  for (const ch of s) {
    if (waiting) { if (ch === '\r' || ch === ESC) { const w = waiting; waiting = null; w(ch === '\r'); } continue; }
    if (ch === '\r') { const p = line.trim(); line = ''; if (p) void run(p); else out('\r\n> '); }
    else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); out('\b \b'); } }
    else if (ch >= ' ') { line += ch; out(ch); }
  }
});
