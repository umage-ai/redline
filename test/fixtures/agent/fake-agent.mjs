// A stand-in agent CLI for the agent panel's tests (D53). Like Claude Code it asks the terminal
// `OSC 7501 ; ?` and sends DA1 (`CSI c`) right after as a "no more replies" sentinel: it reports
// status only when the 7501 answer arrived before the DA1 answer. It turns on bracketed paste,
// echoes what it gets, and treats a line (Enter) as a prompt: working, then done with a message.
// "exit" quits with code 3; "ask" waits for approval (blocked: Enter approves, Esc denies); "slow …" stays working for 8 s.

const ESC = '\x1b', ST = ESC + '\\';
const out = s => process.stdout.write(s);
const report = (fields) => { if (supported) out(`${ESC}]7501;${fields}:app=fake-agent${ST}`); };
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

let supported = false, probing = true, line = '', asking = false;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
out('fake agent starting\r\n');
out(`${ESC}]7501;?${ST}${ESC}[c`);
const giveUp = setTimeout(() => { probing = false; ready(); }, 3000);

function ready() {
  out(`${ESC}[?2004h`);
  out(`status reporting: ${supported ? 'yes' : 'no'}\r\n> `);
  report('state=idle');
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
    // Esc while asking: denied (the agent toolbar's Deny); Enter on an empty line approves (Allow).
    if (ch === ESC && asking) { asking = false; line = ''; out('denied\r\n> '); report(`state=done:msg=${b64('denied')}`); continue; }
    if (ch === '\r') {
      const prompt = line.trim();
      line = '';
      out('\r\n');
      if (prompt === 'exit') { report('state=clear'); process.exit(3); }
      if (asking) { asking = false; out(`answer: ${prompt || 'yes'}\r\n> `); report(`state=done:msg=${b64(`approved: ${prompt || 'yes'}`)}`); continue; }
      if (!prompt) { out('> '); continue; }
      // "ask": waits for approval (blocked, permission) until the next line.
      if (prompt === 'ask') { asking = true; out('Allow editing src/App.tsx? (y/n) '); report(`state=blocked:kind=permission:msg=${b64('Edit src/App.tsx?')}`); continue; }
      report('state=working');
      setTimeout(() => {
        out(`did: ${prompt}\r\n> `);
        report(`state=done:msg=${b64(`did ${prompt.slice(0, 40)}`)}`);
      }, prompt.startsWith('slow') ? 8000 : 1500);   // long enough for a test to see "working"; "slow …": a while
    } else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); out('\b \b'); } }
    else if (ch >= ' ') { line += ch; out(ch); }
  }
});
