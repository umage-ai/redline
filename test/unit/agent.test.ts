// The agent panel (D53): OSC 7501 parsing (the spec's rules), the record precedence, the output
// scanner (probe + DA1 answered in order, across chunks), command lookup on Windows, and the HTTP
// flow end to end with a fake agent in a real pseudo-terminal (node-pty; the bundled ConPTY on Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { decodeText, OscScanner, parseReport, ProgramRecords } from '../../agent/src/program-status.ts';
import { checkPick, resolveCommand, withInstructions } from '../../agent/src/server.ts';
import { agent } from '../../agent/src/index.ts';
import { adapterFor, choices, claudeCode, cliChoices, defaultCommand, openCode } from '../../agent/src/adapters.ts';
import { agentFor, type AgentAdapter } from '../../src/server/agent-hook.ts';
import { createHandler } from '../../src/server/handler.ts';
import { freeIds, initials, noteTag, overall, pickCli, shorten, stateLabel, tabRank, tabTitle, tagFor, visibleTabs } from '../../agent/src/panel.ts';
import { pickFor } from '../../agent/src/settings.ts';

const ESC = '\x1b', ST = ESC + '\\';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('parseReport: fields, kinds, progress, base64 text', () => {
  assert.deepEqual(parseReport('state=working:app=claude-code'), { state: 'working', app: 'claude-code' });
  assert.deepEqual(parseReport(`state=blocked:kind=permission:msg=${b64('Run npm test?')}`), { state: 'blocked', kind: 'permission', msg: 'Run npm test?' });
  assert.deepEqual(parseReport('state=working:progress=40:id=build/step-1'), { state: 'working', progress: 40, id: 'build/step-1' });
  assert.equal(parseReport('state=done:kind=permission')?.kind, undefined, 'kind only with blocked');
  assert.equal(parseReport('state=working:progress=140')?.progress, undefined, 'out of range = absent');
  assert.equal(parseReport('state=working:app=has space')?.app, undefined, 'odd app = absent');
  assert.equal(parseReport('state=idle:state=done')?.state, 'done', 'last repeat wins');
  assert.equal(parseReport('state=idle:Bad=1:x')?.state, 'idle', 'malformed pairs are skipped');
});

test('parseReport: a report that breaks a rule is dropped whole', () => {
  assert.equal(parseReport(''), null);
  assert.equal(parseReport('app=x'), null, 'no state');
  assert.equal(parseReport('state=sleeping'), null, 'unknown state');
  assert.equal(parseReport('state=idle:id=a//b'), null, 'bad id');
  assert.equal(parseReport(`state=idle:id=${Array(9).fill('a').join('/')}`), null, 'id too deep');
  assert.equal(parseReport('state=idle:abcdefghijklmnopq=1'), null, 'key over 16 bytes');
  assert.deepEqual(parseReport('state=idle:msg=@@@'), { state: 'idle' }, 'a value outside the character set: that pair is skipped');
  assert.equal(parseReport(`state=idle:msg=${b64('two\nlines')}`), null, 'line break in text');
  assert.equal(parseReport(`state=idle:msg=${b64('\u2028')}`), null, 'line separator in text');
  assert.equal(parseReport('state=idle:msg=abc'), null, 'bad base64 length');
  assert.equal(parseReport(`state=idle:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`), null, 'invalid UTF-8');
  assert.equal(parseReport(`state=idle:msg=${b64('x'.repeat(2049))}`), null, 'msg over 2048 bytes');
  assert.equal(parseReport('state=idle:' + 'a=b:'.repeat(1100)), null, 'sequence over 4096 bytes');
});

test('decodeText strips invisible format characters', () => {
  assert.equal(decodeText(b64('a\u202eb\u200bc'), 100), 'abc');
});

test('ProgramRecords: blocked > working > error > done > idle; clear; lifetimes', () => {
  const r = new ProgramRecords();
  assert.equal(r.status().state, 'idle');
  r.apply({ state: 'done' }, 1);
  r.apply({ state: 'working', id: 'bg' }, 2);
  assert.equal(r.status().state, 'working', 'live work outranks a finished result');
  r.apply({ state: 'blocked', kind: 'question', msg: 'Which file?' }, 3);
  assert.deepEqual([r.status().state, r.status().kind, r.status().msg], ['blocked', 'question', 'Which file?']);
  r.apply({ state: 'clear', id: 'bg' }, 4);
  r.apply({ state: 'done', msg: 'ok' }, 5);
  assert.equal(r.status().state, 'done');
  r.apply({ state: 'error', id: 'x' }, 6);
  assert.equal(r.status().state, 'error');
  r.acknowledge();
  assert.equal(r.status().state, 'idle', 'acknowledging retires done and error');
  r.apply({ state: 'working', id: 'a' }, 7); r.apply({ state: 'working', id: 'a/b' }, 8); r.apply({ state: 'done', id: 'c' }, 9);
  r.apply({ state: 'clear', id: 'a' }, 10);
  assert.equal(r.status().records, 1, 'clear removes the id and its children');
  r.apply({ state: 'working' }, 11);
  r.dropTransient();
  assert.equal(r.status().state, 'done', 'exit drops working, keeps results');
  r.apply({ state: 'clear' }, 12);
  assert.equal(r.status().records, 0, 'a root clear removes everything');
});

test('ProgramRecords: ties go to the root, then the most recent; the cap evicts the oldest', () => {
  const r = new ProgramRecords(3);
  r.apply({ state: 'working', id: 'a', msg: 'child' }, 1);
  r.apply({ state: 'working', msg: 'root' }, 0);
  assert.equal(r.status().msg, 'root');
  r.apply({ state: 'idle', id: 'b' }, 2); r.apply({ state: 'idle', id: 'c' }, 3); r.apply({ state: 'idle', id: 'd' }, 4);
  assert.equal(r.status().records, 3);
});

test('OscScanner: probes, DA1 and reports in order, split across chunks, BEL or ST', () => {
  const s = new OscScanner();
  const all = [
    ...s.feed(`hello ${ESC}]75`), ...s.feed(`01;?${ST}${ESC}[`), ...s.feed(`c more ${ESC}]7501;state=work`),
    ...s.feed(`ing:app=x\x07 ${ESC}[>c ${ESC}[0c ${ESC}]7501;state=nope${ST}`),
  ];
  assert.deepEqual(all, [{ type: 'probe' }, { type: 'da1' }, { type: 'report', report: { state: 'working', app: 'x' } }, { type: 'da1' }]);
  assert.deepEqual(new OscScanner().feed(`${ESC}]7501;` + 'x'.repeat(5000)), [], 'an endless sequence is not buffered forever');
});

test('resolveCommand: PATHEXT on Windows, .cmd shims through cmd.exe; elsewhere as given', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-cmd-'));
  await fs.writeFile(path.join(dir, 'tool.cmd'), '@echo off');
  await fs.writeFile(path.join(dir, 'other.exe'), '');
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\cmd.exe' };
  assert.deepEqual(resolveCommand('tool', ['-x'], env, 'win32'), { file: 'C:\\Windows\\cmd.exe', args: ['/d', '/c', path.join(dir, 'tool.cmd'), '-x'] });
  assert.deepEqual(resolveCommand('other', [], env, 'win32'), { file: path.join(dir, 'other.exe'), args: [] });
  assert.equal(resolveCommand('missing', [], env, 'win32'), null);
  assert.deepEqual(resolveCommand('claude', ['a'], env, 'linux'), { file: 'claude', args: ['a'] });
});

/** An SSE reader: the events so far, and a wait for one that matches. */
function sse(url: string) {
  const events: { event: string; data: any }[] = [];
  const waiters: (() => void)[] = [];
  let req!: http.ClientRequest;
  const ready = new Promise<number>((resolve, reject) => {
    req = http.get(url, { headers: { host: new URL(url).host } }, res => {
      resolve(res.statusCode ?? 0);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data !== undefined) { events.push({ event, data: JSON.parse(data) }); waiters.splice(0).forEach(w => w()); }
        }
      });
    }).on('error', reject);
  });
  /** The first event matching `pred`, from event `from` on (`mark()` before the action that causes it). */
  async function until(pred: (e: { event: string; data: any }) => boolean, ms = 20_000, from = 0) {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events.map(e => e.event === 'data' ? 'data' : `${e.event}:${JSON.stringify(e.data.status ?? e.data)}`))}`);
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 200); });
    }
  }
  return { events, ready, until, mark: () => events.length, close: () => req.destroy() };
}

test('agent routes: the fake agent reports through OSC 7501 once the server answers its probe; prompts, status, menus, exit', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-'));
  const fake = path.resolve('test/fixtures/agent/fake-agent.mjs');
  // It reports itself as Claude Code: its menus are read (menus: 'auto').
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent({ command: process.execPath, args: [fake], env: { FAKE_APP: 'claude-code' }, commands: [{ label: 'Go', prompt: 'go {page}' }], sessions: 'shared' }) });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  const call = async (p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${p}`, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let stream: ReturnType<typeof sse> | undefined;
  try {
    const info = await call('/info');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body.sessions, [], 'no session until one is started');
    assert.equal(info.body.mode, 'shared');
    assert.deepEqual(info.body.commands, [{ label: 'Go', prompt: 'go {page}' }]);
    assert.equal(info.body.key, 'a', 'the Agent button is A by default');
    const token: string = info.body.token;
    const auth = { 'x-redline-agent': token };

    // The guards: token, header, origin.
    assert.equal((await call('/start', {})).status, 403, 'no token');
    assert.equal((await call('/start', {}, { 'x-redline-agent': 'nope' })).status, 403, 'wrong token');
    assert.equal((await fetch(`${base}/start`, { method: 'POST', headers: auth, body: '{}' })).status, 403, 'no x-redline header');
    assert.equal((await call('/start', {}, { ...auth, origin: 'http://evil.example' })).status, 403, 'another origin');
    assert.equal((await call('/stream?token=nope')).status, 403);

    assert.equal((await call('/stream?id=s1&token=' + token)).status, 404, 'no such session yet');

    const started = await call('/start', { cols: 90, rows: 20 }, auth);
    assert.equal(started.status, 200);
    assert.equal(started.body.id, 's1');
    stream = sse(`${base}/stream?id=s1&token=${token}`);
    assert.equal(await stream.ready, 200);
    // The probe answered before the DA1 sentinel: the fake agent says so, and reports idle.
    await stream.until(e => (e.event === 'data' ? String(e.data) : String(e.data.scrollback ?? '')).includes('status reporting: yes'));
    const idle = await stream.until(e => e.event === 'status' && e.data.status.source === '7501' && e.data.status.state === 'idle');
    assert.equal(idle.data.app, 'claude-code');

    // Allow/Deny only while it waits for approval.
    assert.equal((await call('/answer', { choice: 'allow' }, auth)).status, 409, 'not blocked');
    assert.equal((await call('/answer', { choice: 'maybe' }, auth)).status, 400);

    // A prompt that names notes: they are remembered (the panel tags them "sent"); bad ids are dropped.
    assert.equal((await call('/send', { text: 'fix the header', notes: ['n1', 'n2', '../x', 7] }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'working');
    const done = await stream.until(e => e.event === 'status' && e.data.status.state === 'done');
    assert.equal(done.data.status.msg, 'did fix the header');
    assert.deepEqual(done.data.sent, ['n1', 'n2']);
    assert.deepEqual((await call('/info')).body.sessions[0].sent, ['n1', 'n2']);
    assert.ok(stream.events.some(e => e.event === 'data' && String(e.data).includes('did: fix the header')), 'the prompt reached the program');

    assert.equal((await call('/ack', {}, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'idle' && e.data.running);

    // Waiting for approval: Allow sends Enter, Deny sends Esc (the defaults, Claude Code's prompt).
    let m = stream.mark();
    assert.equal((await call('/input', { data: 'ask\r' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'blocked' && e.data.status.kind === 'permission', undefined, m);
    assert.equal((await call('/answer', { choice: 'allow' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'done' && e.data.status.msg === 'approved: yes');
    m = stream.mark();
    assert.equal((await call('/input', { data: 'ask\r' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'blocked', undefined, m);
    assert.equal((await call('/answer', { choice: 'deny' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'done' && e.data.status.msg === 'denied');

    // The menu is read off the screen and sent with the status; /choose picks an option (arrows, then Enter).
    assert.equal((await call('/choose', { index: 0 }, auth)).status, 409, 'no menu on screen');
    m = stream.mark();
    assert.equal((await call('/input', { data: 'ask\r' }, auth)).status, 200);
    const ask = await stream.until(e => e.event === 'status' && e.data.prompt?.options?.length === 3, undefined, m);
    assert.equal(ask.data.prompt.question, 'Do you want to make this edit to src/App.tsx?');
    assert.deepEqual(ask.data.prompt.options.map((o: { label: string }) => o.label), ['Yes', "Yes, and don't ask again this session", 'No']);
    assert.ok(ask.data.prompt.lines.some((l: { t: string; bg?: string }[]) => l.some(s => s.t.includes('+  <button>') && s.bg)), 'the diff keeps its colour');
    assert.equal((await call('/choose', { index: 1 }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.msg === 'approved: always' && !e.data.prompt);

    // Stepped questions: an option, then a typed answer, then the review step's Submit.
    assert.equal((await call('/input', { data: 'form\r' }, auth)).status, 200);
    const form = await stream.until(e => e.event === 'status' && e.data.prompt?.steps?.length === 3);
    assert.deepEqual(form.data.prompt.steps.map((s: { label: string; state: string; current: boolean }) => `${s.state}:${s.label}${s.current ? '*' : ''}`), ['todo:Color*', 'todo:Size', 'submit:Submit']);
    assert.equal(form.data.prompt.options[0].description, 'Bold, for warnings and primary calls to action.');
    assert.equal((await call('/choose', { index: 1 }, auth)).status, 200);
    const size = await stream.until(e => e.event === 'status' && e.data.prompt?.question === 'Which size should the button be?');
    assert.equal(size.data.prompt.options[2].input, true);
    assert.equal((await call('/choose', { index: 2, text: 'XL' }, auth)).status, 200);
    const review = await stream.until(e => e.event === 'status' && e.data.prompt?.question === 'Ready to submit your answers?');
    assert.ok(review.data.prompt.lines.some((l: { t: string }[]) => l.map(s => s.t).join('').includes('→ XL')));
    assert.equal((await call('/choose', { index: 0 }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.msg === 'answered: Color=Blue, Size=XL');

    // Keys typed in the terminal; "exit" ends it with code 3.
    assert.equal((await call('/input', { data: 'exit\r' }, auth)).status, 200);
    const exit = await stream.until(e => e.event === 'exit');
    // node-pty on Windows sometimes reports a fast exit without its code (L54): null, never a wrong one.
    assert.ok(exit.data.exitCode === 3 || (process.platform === 'win32' && exit.data.exitCode === null), `exit code ${exit.data.exitCode}`);
    assert.equal((await call('/info')).body.sessions[0].running, false);

    // A prompt while stopped (the shared session) starts the agent and waits until it is ready.
    assert.equal((await call('/send', { text: 'second' }, auth)).status, 200);
    await stream.until(e => e.event === 'data' && String(e.data).includes('did: second'));
    // Stop an idle agent: the process must survive it (a second kill() in node-pty aborted Node, L54).
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await call('/stop', {}, auth)).status, 200);
    await stream.until(e => e.event === 'exit' && stream!.events.filter(x => x.event === 'exit').length === 2);
    await new Promise(r => setTimeout(r, 1500));
    const after = (await call('/info')).body;
    assert.equal(after.sessions.length, 1, 'shared: one session throughout');
    assert.equal(after.sessions[0].running, false, 'still answering after the stop');
  } finally {
    stream?.close();
    await call('/stop', {}, { 'x-redline-agent': (await call('/info')).body?.token ?? '' }).catch(() => {});
    server.closeAllConnections();
    server.close();
  }
});

test('agent routes: stopping a running agent leaves the dev server up (node-pty aborted Node on a second kill, L54)', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-stop-'));
  const fake = path.resolve('test/fixtures/agent/fake-agent.mjs');
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent({ command: process.execPath, args: [fake] }) });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  try {
    const { token, mode } = await (await fetch(`${base}/info`)).json();
    assert.equal(mode, 'fresh', 'fresh sessions by default (since 0.10)');
    const h = { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': token };
    assert.equal((await fetch(`${base}/start`, { method: 'POST', headers: h, body: '{}' })).status, 200);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await fetch(`${base}/stop`, { method: 'POST', headers: h, body: '{}' })).status, 200);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal((await (await fetch(`${base}/info`)).json()).sessions[0].running, false);
  } finally { server.closeAllConnections(); server.close(); }
});

test('agent routes: fresh sessions (one per prompt, the cap, a finished one makes room), instructions ahead of the first prompt, no menus for another CLI', { timeout: 90_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-fresh-'));
  const fake = path.resolve('test/fixtures/agent/fake-agent.mjs');
  // The fake reports app=fake-agent: not Claude Code, so its menus aren't read (Allow/Deny instead).
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent({ command: process.execPath, args: [fake], sessions: 'fresh', maxSessions: 2, instructions: 'House rules first.', key: false }) });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  const { token, mode, max, key } = await (await fetch(`${base}/info`)).json();
  assert.deepEqual([mode, max], ['fresh', 2]);
  assert.equal(key, false, 'key: false leaves A to an extension');
  const call = async (p: string, body: unknown) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const feed = sse(`${base}/stream?status=1&token=${token}`);
  type S = { id: string; app?: string; running: boolean; status: { state: string; kind?: string; msg?: string }; prompt?: unknown; sent: string[] };
  const when = (pred: (ss: S[]) => boolean) => feed.until(e => (e.event === 'status' || e.event === 'hello') && pred(e.data.sessions));
  const byId = (ss: S[], id: string) => ss.find(x => x.id === id);
  try {
    assert.equal(await feed.ready, 200);
    // Each prompt: a new session, with its own notes. The instructions go ahead of its first prompt.
    assert.deepEqual((await call('/send', { text: 'one', notes: ['a'] })).body, { ok: true, id: 's1' });
    assert.deepEqual((await call('/send', { text: 'two', notes: ['b'] })).body, { ok: true, id: 's2' });
    const both = await when(ss => ss.length === 2 && ss.every(x => x.status.state === 'done'));
    assert.equal(byId(both.data.sessions, 's1')!.status.msg, 'did House rules first.one');
    assert.equal(byId(both.data.sessions, 's2')!.status.msg, 'did House rules first.two');
    assert.deepEqual(both.data.sessions.map((x: S) => x.sent), [['a'], ['b']]);

    // Not Claude Code: no menu read, /choose refuses; Allow/Deny answer it.
    assert.equal((await call('/input', { id: 's1', data: 'ask\r' })).status, 200);
    const asking = await when(ss => byId(ss, 's1')?.status.state === 'blocked');
    assert.equal(byId(asking.data.sessions, 's1')!.prompt, undefined);
    assert.equal((await call('/choose', { id: 's1', index: 1 })).status, 409);
    assert.equal((await call('/answer', { id: 's1', choice: 'allow' })).status, 200);
    await when(ss => byId(ss, 's1')?.status.msg === 'approved: yes');

    // At the cap (2 running): a new prompt stops the oldest finished session to make room.
    assert.equal((await call('/send', { text: 'slow three' })).body.id, 's3');
    await when(ss => byId(ss, 's1')?.running === false && byId(ss, 's3')?.status.state === 'working' && byId(ss, 's3')?.app !== undefined);   // reported: the prompt is in, not just start-up output
    assert.equal((await call('/send', { text: 'slow four' })).body.id, 's4');
    await when(ss => byId(ss, 's2')?.running === false && byId(ss, 's4')?.status.state === 'working' && byId(ss, 's4')?.app !== undefined);
    // Both running ones busy: refused.
    const busy = await call('/send', { text: 'five' });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /2 sessions are busy/);

    // An ended session can be closed; a running one can't; unknown ids are 404.
    assert.equal((await call('/dismiss', { id: 's3' })).status, 409);
    assert.equal((await call('/dismiss', { id: 's1' })).status, 200);
    assert.equal((await call('/input', { id: 's1', data: 'x' })).status, 404);
    await when(ss => !byId(ss, 's1'));

    // End: stop and close in one, running or not.
    assert.equal((await call('/end', { id: 's4' })).status, 200);
    await when(ss => !byId(ss, 's4'));
    assert.equal((await call('/end', { id: 's4' })).status, 404);

    // Back to one shared session: a prompt goes to the newest.
    assert.equal((await call('/mode', { mode: 'shared' })).body.mode, 'shared');
    assert.equal((await call('/stop', { id: 's3' })).status, 200);
    await when(ss => byId(ss, 's3')?.running === false);
    assert.equal((await call('/mode', { mode: 'nope' })).status, 400);
  } finally {
    feed.close();
    await call('/stop', {}).catch(() => {});   // no id: every session
    await new Promise(r => setTimeout(r, 1000));
    server.closeAllConnections();
    server.close();
  }
});

test('agent instructions: Claude Code gets a system-prompt file, any other CLI a preamble', async () => {
  assert.deepEqual(await withInstructions('claude', ['-c'], { text: '' }), { args: ['-c'], preamble: '' });
  assert.deepEqual(await withInstructions('codex', [], { text: 'Rules.' }), { args: [], preamble: 'Rules.' });
  assert.deepEqual(await withInstructions('C:\\tools\\claude.exe', [], { text: 'Rules.', file: '/repo/agent.md' }), { args: ['--append-system-prompt-file', '/repo/agent.md'], preamble: '' });
  const r = await withInstructions('claude', ['--model', 'x'], { text: 'Use the redline skill.' });
  assert.deepEqual(r.args.slice(0, 3), ['--model', 'x', '--append-system-prompt-file']);
  assert.equal(await fs.readFile(r.args[3], 'utf8'), 'Use the redline skill.');
});

test('agent routes: only this machine, whatever the network option says; the panel is left out of its config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-'));
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent(), network: true });
  const res = (r: { statusCode?: number; body?: string }) => Object.assign(r, {
    setHeader() {}, getHeader() {}, end(b?: string) { r.body = b; }, writeHead() {}, write() {}, on() {},
  });
  const call = (url: string, host: string) => new Promise<{ statusCode?: number; body?: string }>(resolve => {
    const r: { statusCode?: number; body?: string } = {};
    const out = res(r) as never as http.ServerResponse;
    (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { r.body = b; resolve(r); };
    api({ url, method: 'GET', headers: { host }, socket: { remoteAddress: '192.168.1.9' } } as never, out, () => resolve({ statusCode: 404 }));
  });
  assert.equal((await call('/__redline/agent/info', '192.168.1.2:5173')).statusCode, 403);
  const config = JSON.parse((await call('/__redline/config', '192.168.1.2:5173')).body!);
  assert.ok(!config.extensions.some((u: string) => u.includes('/agent/')), 'remote reviewers get no agent panel');
});

test('agent toolbar: the state chip and the note tags', () => {
  const st = (state: string, extra: object = {}, running = true) => stateLabel({ running, command: 'claude', status: { state, source: '7501', ...extra } as never });
  assert.deepEqual(st('idle', {}, false), { label: 'Not started', color: '#5c5c66' });
  assert.equal(stateLabel({ running: false, command: 'c', exitCode: 3, status: { state: 'idle', source: 'none' } }).label, 'Stopped (exit 3)');
  assert.equal(st('working', { progress: 40 }).label, 'Working 40%');
  assert.equal(st('working').label, 'Working…');
  assert.deepEqual(st('blocked', { kind: 'permission', msg: 'Edit a.ts?' }), { label: 'Needs your approval', msg: 'Edit a.ts?', color: '#ff9f0a' });
  assert.equal(st('blocked', { kind: 'question' }).label, 'Needs your answer');
  assert.equal(st('done', { msg: 'did it' }, false).label, 'Done', 'a finished run still says done');
  const sent = new Set(['a']);
  assert.equal(noteTag({ id: 'a', done: false }, sent), 'sent');
  assert.equal(noteTag({ id: 'a', done: true }, sent), 'done');
  assert.equal(noteTag({ id: 'b', done: true }, sent), null, 'done by hand, never sent: no tag');
  // Several sessions: the indicator shows the one that most needs you; a fresh session gets the notes no running one has.
  const ses = (id: string, state: string, running = true, sentIds: string[] = []) => ({ id, label: '#' + id, running, command: 'c', sent: sentIds, status: { state, source: '7501' } as never });
  assert.equal(overall([ses('1', 'working'), ses('2', 'blocked'), ses('3', 'done')])?.id, '2');
  assert.equal(overall([ses('1', 'done'), ses('2', 'working')])?.id, '2');
  assert.equal(overall([ses('1', 'idle', false)]), undefined, 'nothing running, nothing finished');
  const rl = { notes: () => [{ id: 'a', done: false }, { id: 'b', done: false }, { id: 'c', done: true }] } as never;
  assert.deepEqual(freeIds(rl, [ses('1', 'working', true, ['a']), ses('2', 'done', false, ['b'])]), ['b'], 'a is with a running session; c is done');
  // The count is the same in both modes (it used to jump between 0 and 1 with Fresh): a running session keeps its notes, resting or not.
  assert.deepEqual(freeIds(rl, [ses('1', 'done', true, ['a'])]), ['b'], 'a rests with #1: not handed over again');
  // The note's tag says what is happening to it: worked on, asking, sent (resting or stopped), done.
  const who = (x: { label: string }) => `c ${x.label}`;
  assert.deepEqual(tagFor({ id: 'a', done: false }, [ses('1', 'working', true, ['a'])], who), { cls: 'sent working', text: 'c #1 is working on it' });
  assert.deepEqual(tagFor({ id: 'a', done: false }, [ses('1', 'blocked', true, ['a'])], who), { cls: 'sent asking', text: 'c #1 needs your answer' });
  assert.deepEqual(tagFor({ id: 'a', done: false }, [ses('1', 'working', false, ['a'])], who), { cls: 'sent', text: '⤳ sent to c #1' }, 'stopped: just sent');
  assert.deepEqual(tagFor({ id: 'a', done: true }, [ses('1', 'done', true, ['a']), ses('2', 'working', true, ['a'])], who), { cls: 'done', text: '✓ done by c #2' }, 'the newest session that had it');
  assert.equal(tagFor({ id: 'z', done: false }, [ses('1', 'working', true, ['a'])], who), null);
  // Many sessions: 3 tabs (the one on screen, any asking, then the newest busy or unseen, resting, ended), the rest
  // behind "+N"; on the toolbar busy ones first, ended ones last (D62), in session order within.
  const many = [ses('1', 'done', false), ses('2', 'blocked'), ses('3', 'done', false), ses('4', 'working'), ses('5', 'done'), ses('6', 'working')];
  assert.deepEqual(visibleTabs(many, '1'), { shown: ['2', '6', '1'], hidden: ['4', '5', '3'] }, 'picked by hand and asking stay; the newest busy fills up; the ended one goes right');
  assert.deepEqual(visibleTabs(many, '6').shown, ['2', '5', '6'], 'in session order among the busy');
  assert.deepEqual(visibleTabs([ses('1', 'idle'), ses('2', 'done', false), ses('3', 'working')], '2'), { shown: ['3', '1', '2'], hidden: [] }, 'three or fewer: all; busy, then resting (seen), then ended');
  assert.deepEqual([tabRank(ses('1', 'done')), tabRank(ses('1', 'idle')), tabRank(ses('1', 'working', false))], [0, 1, 2]);
  // Tab names (D62): the first note's text, shortened, "+N" for more; a text change by its new text; no notes: the prompt's label.
  const note = (body: string, extra: object = {}) => ({ body, type: 'comment', ...extra }) as never;
  assert.equal(tabTitle([note('Purple button')], 'Apply notes'), 'Purple button');
  assert.equal(tabTitle([note('Make this secondary, please'), note('b'), note('c')]), 'Make this seconda… +2');
  assert.equal(tabTitle([note('', { type: 'text', to: 'Plan a  route' })]), 'Plan a route');
  assert.equal(tabTitle([], 'Review page'), 'Review page');
  assert.equal(shorten('  a\nb  '), 'a b');
  assert.deepEqual(['Claude Code', 'OpenCode', 'codex', 'node fake-agent.mjs'].map(initials), ['CC', 'OC', 'C', 'NF']);
});

test('agent option: the core loads @umage.ai/redline-agent only when asked; missing, it warns and runs on', () => {
  const routes = { panel: '/x/agent/panel.js', handle: async () => {} };
  const seen: unknown[] = [];
  const load = () => ({ agent: (o?: unknown) => { seen.push(o); return { routes: () => routes }; } });
  assert.equal(agentFor(undefined, '/r', '/x', load), null);
  assert.equal(agentFor(false, '/r', '/x', load), null);
  assert.equal(agentFor(true, '/r', '/x', load), routes);
  assert.equal(agentFor('codex', '/r', '/x', load), routes);
  assert.equal(agentFor({ command: 'gemini', args: ['-y'] }, '/r', '/x', load), routes);
  assert.deepEqual(seen, [{}, { command: 'codex' }, { command: 'gemini', args: ['-y'] }]);
  // A plugin from the package is used as is, with the root and the API base.
  let ctx: unknown;
  assert.equal(agentFor({ routes: c => { ctx = c; return routes; } }, '/r', '/x', () => { throw new Error('not loaded'); }), routes);
  assert.deepEqual(ctx, { root: '/r', base: '/x' });
  // Not installed: null and one warning, however often it is asked.
  const warn = console.warn, warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    assert.equal(agentFor(true, '/r', '/x', () => null), null);
    assert.equal(agentFor('codex', '/r', '/x', () => null), null);
  } finally { console.warn = warn; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /npm i -D @umage\.ai\/redline-agent/);
});

test('agent adapters (D55): picked by command or reported app, model and instructions per CLI, agent: true picks an installed one', async () => {
  assert.equal(adapterFor('claude').id, 'claude-code');
  assert.equal(adapterFor(String.raw`C:\tools\opencode.cmd`).id, 'opencode');
  assert.equal(adapterFor('node', 'opencode').id, 'opencode', 'the app a CLI reports picks it too');
  assert.equal(adapterFor('codex').id, 'generic');
  const mine = { ...openCode, id: 'mine', matches: (c: string) => c === 'opencode' };
  assert.equal(adapterFor('opencode', undefined, [mine]).id, 'mine', 'your adapters first');
  // The model: Claude Code's flag (not twice); OpenCode has none, so a warning and its own config.
  assert.deepEqual(await withInstructions('claude', [], { text: '' }, 'opus'), { args: ['--model', 'opus'], preamble: '' });
  assert.deepEqual((await withInstructions('claude', ['--model', 'x'], { text: '' }, 'opus')).args, ['--model', 'x']);
  const oc = await withInstructions('opencode', [], { text: 'Rules.' }, 'qwen');
  assert.deepEqual([oc.args, oc.preamble], [[], 'Rules.']);
  assert.match(oc.warning ?? '', /OpenCode takes no model or effort flag/);
  // agent: true → the first installed of claude, opencode; claude when neither is.
  assert.equal(defaultCommand([], c => c === 'opencode'), 'opencode');
  assert.equal(defaultCommand([], c => c === 'claude' || c === 'opencode'), 'claude');
  assert.equal(defaultCommand([], () => false), 'claude');
});

test('agent adapters: a CLI that reports idle instead of done (OpenCode) shows done after a turn, idle once seen', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-oc-'));
  const fake = path.resolve('test/fixtures/agent/fake-agent.mjs');
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent({ command: process.execPath, args: [fake], env: { FAKE_APP: 'opencode', FAKE_NO_DONE: '1' }, sessions: 'shared' }) });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  const { token } = await (await fetch(`${base}/info`)).json();
  const call = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': token }, body: JSON.stringify(body) });
  const feed = sse(`${base}/stream?status=1&token=${token}`);
  type S = { app?: string; status: { state: string } };
  const when = (pred: (ss: S[]) => boolean) => feed.until(e => (e.event === 'status' || e.event === 'hello') && pred(e.data.sessions));
  try {
    assert.equal(await feed.ready, 200);
    await call('/send', { text: 'go' });
    await when(ss => ss[0]?.app === 'opencode' && ss[0].status.state === 'working');
    await when(ss => ss[0]?.status.state === 'done');   // it said idle; the turn it worked on is done
    await call('/ack', {});
    await when(ss => ss[0]?.status.state === 'idle');
  } finally {
    feed.close();
    await call('/end', {}).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    server.closeAllConnections();
    server.close();
  }
});

test('agent CLIs (D59): every installed adapter, a configured list, or one command; ids, names, the remembered pick', () => {
  const ids = (o: object, has: (c: string) => boolean) => cliChoices(o, has).map(c => `${c.id}=${c.name}:${[c.command, ...c.args].join(' ')}`);
  // Detected: each installed adapter, the option's args with each, the default first; none installed: claude.
  assert.deepEqual(ids({}, () => true), ['claude-code=Claude Code:claude', 'opencode=OpenCode:opencode']);
  assert.deepEqual(ids({ args: ['-x'] }, c => c === 'opencode'), ['opencode=OpenCode:opencode -x']);
  assert.deepEqual(ids({}, () => false), ['claude-code=Claude Code:claude']);
  // An explicit command: that one alone, installed or not (its start says it wasn't found).
  assert.deepEqual(ids({ command: 'codex', args: ['-y'], label: 'Codex' }, () => true), ['codex=Codex:codex -y']);
  // clis: by adapter id or command, any other command, or an object; the installed ones; duplicates once, ids unique.
  const warn = console.warn, warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    assert.deepEqual(ids({ clis: ['opencode', 'claude-code', 'aider', { command: 'node', args: ['a.mjs'] }, { command: 'node', args: ['b.mjs'], label: 'B' }, 'claude'], command: 'ignored' }, c => c !== 'aider'),
      ['opencode=OpenCode:opencode', 'claude-code=Claude Code:claude', 'node=node a.mjs:node a.mjs', 'node-2=B:node b.mjs']);
    assert.match(warnings.join('\n'), /not installed, left out of the picker: aider/);
    assert.deepEqual(ids({ clis: [{ command: 'x', id: 'mine', label: 'Mine' }] }, () => false), ['mine=Mine:x'], 'none installed: the first, to fail at start');
  } finally { console.warn = warn; }
  assert.equal(cliChoices({ clis: [{ command: 'node', env: { A: '1' } }] }, () => true)[0].env?.A, '1');
  // The panel's pick: remembered if still offered, else the server's default, else the first.
  const list = [{ id: 'a', name: 'A', command: 'a' }, { id: 'b', name: 'B', command: 'b' }];
  assert.equal(pickCli(list, 'b', 'a'), 'b');
  assert.equal(pickCli(list, 'gone', 'a'), 'a');
  assert.equal(pickCli(list, null, 'nope'), 'a');
  assert.equal(pickCli([], 'b'), '');
});

test('agent CLIs (D59): sessions of two CLIs side by side (fresh); shared switches CLI only between turns', { timeout: 90_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-clis-'));
  const fake = path.resolve('test/fixtures/agent/fake-agent.mjs');
  // The fake agent twice, as two CLIs that report different apps.
  const clis = [
    { id: 'one', label: 'Fake One', command: process.execPath, args: [fake], env: { FAKE_APP: 'fake-one' } },
    { id: 'two', label: 'Fake Two', command: process.execPath, args: [fake, '--two'], env: { FAKE_APP: 'fake-two' } },
  ];
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent({ clis, sessions: 'fresh' }) });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  const info = await (await fetch(`${base}/info`)).json();
  assert.deepEqual(info.clis, [{ id: 'one', name: 'Fake One', command: 'Fake One', models: [], efforts: [] }, { id: 'two', name: 'Fake Two', command: 'Fake Two', models: [], efforts: [] }]);
  assert.equal(info.cli, 'one', 'the first is the default');
  const call = async (p: string, body: unknown) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': info.token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const feed = sse(`${base}/stream?status=1&token=${info.token}`);
  type S = { id: string; cli: string; app?: string; running: boolean; status: { state: string; msg?: string } };
  const when = (pred: (ss: S[]) => boolean) => feed.until(e => (e.event === 'status' || e.event === 'hello') && pred(e.data.sessions));
  const byId = (ss: S[], id: string) => ss.find(x => x.id === id);
  try {
    assert.equal(await feed.ready, 200);
    assert.equal((await call('/send', { text: 'x', cli: 'nope' })).status, 400, 'an unknown CLI');
    // Fresh: each prompt its own session, of the CLI it names (none: the default).
    assert.equal((await call('/send', { text: 'first', cli: 'two' })).body.id, 's1');
    assert.equal((await call('/send', { text: 'second' })).body.id, 's2');
    const both = await when(ss => ss.length === 2 && ss.every(x => x.status.state === 'done'));
    assert.deepEqual(both.data.sessions.map((x: S) => [x.id, x.cli, x.app]), [['s1', 'two', 'fake-two'], ['s2', 'one', 'fake-one']]);
    // The terminal's Start: a new session of the CLI named.
    const started = await call('/start', { cli: 'two' });
    assert.equal(started.body.cli, 'two');
    await call('/end', {});
    await when(ss => ss.length === 0);

    // Shared: a prompt naming another CLI stops the shared session and starts that one; never mid-turn.
    assert.equal((await call('/mode', { mode: 'shared' })).status, 200);
    assert.equal((await call('/send', { text: 'slow one', cli: 'one' })).body.id, 's1');
    await when(ss => byId(ss, 's1')?.app === 'fake-one' && byId(ss, 's1')?.status.state === 'working');   // reported: the prompt is in
    const busy = await call('/send', { text: 'now', cli: 'two' });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /is busy: wait until it is done, or end it, to switch to Fake Two/);
    assert.equal((await call('/send', { text: 'more', cli: 'one' })).body.id, 's1', 'the same CLI: the same session');
    await when(ss => byId(ss, 's1')?.status.msg === 'did more');
    assert.equal((await call('/send', { text: 'switched', cli: 'two' })).body.id, 's2');
    const switched = await when(ss => byId(ss, 's1')?.running === false && byId(ss, 's2')?.status.msg === 'did switched');
    assert.equal(byId(switched.data.sessions, 's2')!.app, 'fake-two');
    assert.equal(switched.data.sessions.filter((x: S) => x.running).length, 1, 'shared: one running session');
    assert.equal((await call('/send', { text: 'again' })).body.id, 's2', 'no CLI named: the shared session as it is');
  } finally {
    feed.close();
    await call('/stop', {}).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    server.closeAllConnections();
    server.close();
  }
});

test('agent settings (D62): Claude Code takes a model alias and --effort; lists and checks per CLI', async () => {
  // claude --help: --model takes "fable", "opus", "sonnet" (or a full name); --effort low|medium|high|xhigh|max.
  assert.deepEqual(choices(claudeCode.models).map(c => c.value), ['fable', 'opus', 'sonnet']);
  assert.deepEqual(choices(claudeCode.efforts).map(c => c.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(await withInstructions('claude', [], { text: '' }, 'opus', undefined, 'high'), { args: ['--model', 'opus', '--effort', 'high'], preamble: '' });
  assert.deepEqual((await withInstructions('claude', ['--effort', 'low'], { text: '' }, undefined, undefined, 'max')).args, ['--effort', 'low'], 'the args win');
  assert.match((await withInstructions('codex', [], { text: '' }, undefined, undefined, 'high')).warning ?? '', /effort "high" ignored/);
  assert.deepEqual(choices(['a', { value: 'b', name: 'B' }, 'a', '', { value: 'c' }]), [{ value: 'a' }, { value: 'b', name: 'B' }, { value: 'c' }]);
  // The server takes only what it offered: never free text into a CLI's arguments.
  const offer = { models: [{ value: 'opus' }], efforts: [{ value: 'high' }] };
  assert.deepEqual(checkPick({ model: 'opus', effort: 'high' }, offer, 'Claude Code'), { model: 'opus', effort: 'high' });
  assert.deepEqual(checkPick({ model: '', effort: null }, offer, 'Claude Code'), {}, 'empty: the default');
  assert.match((checkPick({ model: '--dangerously-skip-permissions' }, offer, 'Claude Code') as { error: string }).error, /Claude Code offers no model/);
  assert.ok('error' in checkPick({ effort: ['high'] }, offer, 'x'), 'not a string');
  assert.ok('error' in checkPick({ model: 'opus' }, { models: [], efforts: [] }, 'x'), 'a CLI without models');
  // The browser sends only what the CLI still offers.
  const cli = { id: 'c', models: [{ value: 'opus' }], efforts: [{ value: 'high' }] };
  assert.deepEqual(pickFor(cli, { c: { model: 'opus', effort: 'gone' } }), { model: 'opus' });
  assert.deepEqual(pickFor(cli, { other: { model: 'opus' } }), {});
});

test('agent routes (D62): models and effort per CLI in /agent/info; only offered ones reach the CLI as flags, the rest is a 400', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-set-'));
  const fake = path.resolve('test/fixtures/agent/fake-agent.mjs');
  // The fake agent with an adapter like Claude Code's: two models, two effort levels, as flags (it prints them).
  const fakeCode: AgentAdapter = {
    id: 'fake', name: 'Fake Code', command: process.execPath,
    matches: (_c, _app, args) => !!args?.includes(fake) && !args.includes('--two'),
    models: ['fast', { value: 'smart', name: 'Smart' }], efforts: ['low', 'high'],
    start: o => ({ args: [...o.args, ...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : [])] }),
  };
  const clis = [{ id: 'one', command: process.execPath, args: [fake] }, { id: 'two', label: 'Fake Two', command: process.execPath, args: [fake, '--two'] }];
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent({ clis, adapters: [fakeCode], sessions: 'fresh', model: 'fast', effort: 'low' }) });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  const info = await (await fetch(`${base}/info`)).json();
  const call = async (p: string, body: unknown) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': info.token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const streams: ReturnType<typeof sse>[] = [];
  try {
    assert.deepEqual(info.clis.map((c: { id: string; name: string; models: unknown; efforts: unknown }) => [c.id, c.name, c.models, c.efforts]),
      [['one', 'Fake Code', [{ value: 'fast' }, { value: 'smart', name: 'Smart' }], [{ value: 'low' }, { value: 'high' }]], ['two', 'Fake Two', [], []]]);
    assert.deepEqual(info.defaults, { sessions: 'fresh', model: 'fast', effort: 'low' }, 'what Reset goes back to');
    // Refused: a model or effort the CLI doesn't offer (or one for a CLI that offers none), and anything not a string.
    for (const body of [{ cli: 'one', model: 'opus' }, { cli: 'one', effort: 'max' }, { cli: 'two', model: 'fast' }, { cli: 'one', model: 42 }, { model: '--help' }]) {
      const r = await call('/send', { text: 'go', ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, /offers no (model|effort)/);
    }
    assert.equal((await call('/start', { cli: 'one', effort: 'xhigh' })).status, 400, '/start checks too');
    assert.deepEqual((await (await fetch(`${base}/info`)).json()).sessions, [], 'nothing started');

    // Offered: passed as the CLI's flags; the session names them, and the tab name and prompt the panel sent (cleaned).
    const r = await call('/send', { text: 'go', cli: 'one', model: 'smart', effort: 'high', title: 'Purple\nbutton\x1b', task: 'Apply notes', notes: ['n1'] });
    assert.equal(r.status, 200);
    const one = sse(`${base}/stream?id=${r.body.id}&token=${info.token}`);
    streams.push(one);
    await one.until(e => (e.event === 'data' ? String(e.data) : String(e.data.scrollback ?? '')).includes('fake agent starting with --model smart --effort high'));
    const s1 = (await (await fetch(`${base}/info`)).json()).sessions[0];
    assert.deepEqual([s1.model, s1.effort, s1.title, s1.task], ['smart', 'high', 'Purple button', 'Apply notes']);
    // None picked: the options' model and effort.
    const r2 = await call('/send', { text: 'again', cli: 'one' });
    const two = sse(`${base}/stream?id=${r2.body.id}&token=${info.token}`);
    streams.push(two);
    await two.until(e => (e.event === 'data' ? String(e.data) : String(e.data.scrollback ?? '')).includes('fake agent starting with --model fast --effort low'));
  } finally {
    for (const x of streams) x.close();
    await call('/end', {}).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    server.closeAllConnections();
    server.close();
  }
});
