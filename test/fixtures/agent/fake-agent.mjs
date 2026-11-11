// A stand-in agent CLI for the agent panel's tests (D53). Like Claude Code it asks the terminal
// `OSC 7501 ; ?` and sends DA1 (`CSI c`) right after as a "no more replies" sentinel: it reports
// status only when the 7501 answer arrived before the DA1 answer. It turns on bracketed paste,
// echoes what it gets, and treats a line (Enter) as a prompt: working, then done with a message.
// Menus are drawn the way Claude Code draws them (the screen is redrawn whole on every change):
//   "ask"   an edit permission: a red/green diff, "❯ 1. Yes / 2. Yes, and don't ask again / 3. No"
//   "form"  stepped questions: "← ☐ Color ☐ Size ✔ Submit →", options with descriptions,
//           "Type something.", then a review step
// Keys there: ↑/↓ move, a digit picks, Enter picks the ❯ row, ←/→ change step, Esc cancels.
// "exit" quits with code 3; a prompt with "slow" in it stays working for 8 s. FAKE_APP: the app it reports (default fake-agent); FAKE_NO_DONE: idle, not done, after a turn.

const ESC = '\x1b', ST = ESC + '\\';
const out = s => process.stdout.write(s);
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const report = fields => { if (supported) out(`${ESC}]7501;${fields}:app=${process.env.FAKE_APP ?? 'fake-agent'}${ST}`); };
const RULE = '─'.repeat(70), DASH = '╌'.repeat(70);
const dim = s => `${ESC}[2m${s}${ESC}[22m`, inv = s => `${ESC}[7m${s}${ESC}[27m`;

let supported = false, probing = true, ready = false, line = '';
// Its arguments past --two (a model or effort flag from the toolbar's settings, D62) on the first line.
const flags = process.argv.slice(2).filter(a => a !== '--two');
const history = [`fake agent starting${flags.length ? ` with ${flags.join(' ')}` : ''}`];
let menu = null;   // { kind, steps?, step, cursor, typing?, answers, ... }

const COLOR = { q: 'Which colour should the button be?', header: 'Color', options: [['Red', 'Bold, for warnings and primary calls to action.'], ['Blue', 'Calm and trustworthy, a common default.'], ['Green', 'Positive, suits confirm actions.'], ['Type something.']] };
const SIZE = { q: 'Which size should the button be?', header: 'Size', options: [['Small', 'Compact, fits dense layouts.'], ['Large', 'Easy to tap.'], ['Type something.']] };

function draw() {
  const rows = [];
  if (menu?.kind === 'ask') {
    rows.push(RULE, ' Edit file', ' src/App.tsx', DASH, `${ESC}[41m 12 -  <button>New route</button> ${ESC}[0m`, `${ESC}[42m 12 +  <button>+ Plan a route</button> ${ESC}[0m`, DASH,
      ' Do you want to make this edit to src/App.tsx?');
    ['Yes', "Yes, and don't ask again this session", 'No'].forEach((o, i) => rows.push(`${i === menu.cursor ? ' ❯' : '  '} ${i + 1}. ${o}`));
    rows.push('', ' Esc to cancel · Tab to amend');
  } else if (menu?.kind === 'form') {
    const tab = (label, i) => { const mark = i === 2 ? '✔' : menu.answers[i] !== undefined ? '☒' : '☐'; const t = ` ${mark} ${label} `; return i === menu.step ? inv(t) : t; };
    rows.push(RULE, `←  ${[COLOR.header, SIZE.header, 'Submit'].map(tab).join(' ')}  →`, '');
    if (menu.step < 2) {
      const q = [COLOR, SIZE][menu.step];
      rows.push(q.q, '');
      q.options.forEach(([label, desc], i) => {
        const typed = label === 'Type something.' && menu.typing !== undefined && i === menu.cursor;
        rows.push(`${i === menu.cursor ? "❯" : " "} ${i + 1}. ${typed ? menu.typing : label}`);
        if (desc) rows.push(`     ${dim(desc)}`);
      });
      rows.push(RULE, '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel');
    } else {
      rows.push('Review your answers', '');
      [COLOR, SIZE].forEach((q, i) => { if (menu.answers[i] !== undefined) rows.push(` ● ${q.q}`, `   → ${menu.answers[i]}`); });
      rows.push('', 'Ready to submit your answers?', '');
      ['Submit answers', 'Cancel'].forEach((o, i) => rows.push(`${i === menu.cursor ? '❯' : ' '} ${i + 1}. ${o}`));
    }
  } else if (ready) rows.push(...history.slice(-24), `> ${line}`);
  else rows.push(...history);
  out(`${ESC}[2J${ESC}[H${(menu ? [...history.slice(-6), '', ...rows] : rows).join('\r\n')}`);
}

out(`${ESC}]7501;?${ST}${ESC}[c`);
draw();
const giveUp = setTimeout(() => { probing = false; start(); }, 3000);
function start() {
  ready = true;
  out(`${ESC}[?2004h`);
  history.push(`status reporting: ${supported ? 'yes' : 'no'}`);
  draw();
  report('state=idle');
}
const finish = msg => { menu = null; history.push(msg); draw(); report(`state=done:msg=${b64(msg)}`); };

function askKey(k) {
  const n = 3;
  if (k === 'up') menu.cursor = (menu.cursor + n - 1) % n;
  else if (k === 'down') menu.cursor = (menu.cursor + 1) % n;
  else if (k === 'esc') return finish('denied');
  else if (k === 'enter' || /^[1-3]$/.test(k)) {
    const pick = k === 'enter' ? menu.cursor : Number(k) - 1;
    return finish(pick === 0 ? 'approved: yes' : pick === 1 ? 'approved: always' : 'denied');
  }
  draw();
}

function formKey(k) {
  const q = menu.step < 2 ? [COLOR, SIZE][menu.step] : null;
  const n = q ? q.options.length : 2;
  // Like Claude Code: with the ❯ on "Type something.", typed characters go straight into that row.
  const onInput = q && q.options[menu.cursor][0] === 'Type something.';
  if (onInput && menu.typing === undefined && k.length === 1 && k >= ' ' && !/^[1-9]$/.test(k)) menu.typing = '';
  if (menu.typing !== undefined) {   // typing into "Type something."
    if (k === 'enter') { const v = menu.typing.trim(); menu.typing = undefined; if (v) return answer(v); }
    else if (k === 'esc') menu.typing = undefined;
    else if (k === 'back') menu.typing = menu.typing.slice(0, -1);
    else if (k.length === 1) menu.typing += k;
    return draw();
  }
  if (k === 'esc') return finish('questions cancelled');
  if (k === 'left' || k === 'right') { menu.step = Math.max(0, Math.min(2, menu.step + (k === 'left' ? -1 : 1))); menu.cursor = 0; return draw(); }
  if (k === 'up') menu.cursor = (menu.cursor + n - 1) % n;
  else if (k === 'down') menu.cursor = (menu.cursor + 1) % n;
  else if (k === 'enter' || (/^[1-9]$/.test(k) && Number(k) <= n)) {
    const pick = k === 'enter' ? menu.cursor : Number(k) - 1;
    if (!q) return pick === 0 ? finish(`answered: Color=${menu.answers[0] ?? '-'}, Size=${menu.answers[1] ?? '-'}`) : finish('questions cancelled');
    if (q.options[pick][0] === 'Type something.') { menu.cursor = pick; menu.typing = ''; return draw(); }
    return answer(q.options[pick][0]);
  }
  draw();
}
function answer(v) {
  menu.answers[menu.step] = v;
  menu.step++; menu.cursor = 0;
  if (menu.step < 2) report(`state=blocked:kind=question:msg=${b64(`answer: ${[COLOR, SIZE][menu.step].q}`)}`);
  draw();
}

function prompt(p) {
  history.push(`> ${p}`);
  if (p === 'exit') { report('state=clear'); process.exit(3); }
  if (p === 'ask') { menu = { kind: 'ask', cursor: 0 }; draw(); return report(`state=blocked:kind=permission:msg=${b64('Edit src/App.tsx?')}`); }
  if (p === 'form') { menu = { kind: 'form', step: 0, cursor: 0, answers: [] }; draw(); return report(`state=blocked:kind=question:msg=${b64(`answer: ${COLOR.q}`)}`); }
  draw();
  report('state=working');
  setTimeout(() => {
    history.push(`did: ${p}`);
    draw();
    // FAKE_NO_DONE: like OpenCode 2.2, back to idle instead of done.
    report(process.env.FAKE_NO_DONE ? 'state=idle' : `state=done:msg=${b64(`did ${p.slice(0, 40)}`)}`);
  }, p.includes('slow') ? 8000 : 1500);   // long enough for a test to see "working"; "slow": a while
}

const KEYS = [['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'], ['\x1b[200~', ''], ['\x1b[201~', ''], ['\r', 'enter'], ['\t', 'tab'], ['\x7f', 'back'], ['\x1b', 'esc']];
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  let s = chunk;
  if (probing) {
    const osc = s.indexOf(`${ESC}]7501;?`), da = s.search(/\x1b\[\?[\d;]*c/);
    if (osc >= 0 && (da < 0 || osc < da)) supported = true;
    if (da >= 0) { probing = false; clearTimeout(giveUp); start(); }
    s = s.replace(/\x1b\]7501;\?(\x07|\x1b\\)/g, '').replace(/\x1b\[\?[\d;]*c/g, '');
  }
  while (s) {
    const hit = KEYS.find(([seq]) => s.startsWith(seq));
    const [seq, k] = hit ?? [s[0], s[0]];
    s = s.slice(seq.length);
    if (!k || !ready) continue;
    if (menu?.kind === 'ask') askKey(k);
    else if (menu?.kind === 'form') formKey(k);
    else if (k === 'enter') { const p = line.trim(); line = ''; if (p) prompt(p); else draw(); }
    else if (k === 'back') { line = line.slice(0, -1); draw(); }
    else if (k.length === 1 && k >= ' ') { line += k; draw(); }
  }
});
