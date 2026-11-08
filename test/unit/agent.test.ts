// The agent panel (D53): OSC 7501 parsing (the spec's rules), the record precedence, the output
// scanner (probe + DA1 answered in order, across chunks), command lookup on Windows, and the HTTP
// flow end to end with a fake agent in a real pseudo-terminal (node-pty; the bundled ConPTY on Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { decodeText, OscScanner, parseReport, ProgramRecords } from '../../src/server/program-status.ts';
import { resolveCommand } from '../../src/server/agent.ts';
import { createHandler } from '../../src/server/handler.ts';
import { noteTag, stateLabel } from '../../src/agent/panel.ts';

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
  async function until(pred: (e: { event: string; data: any }) => boolean, ms = 20_000) {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events.map(e => e.event === 'data' ? 'data' : `${e.event}:${JSON.stringify(e.data.status ?? e.data)}`))}`);
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 200); });
    }
  }
  return { events, ready, until, close: () => req.destroy() };
}

test('agent routes: the fake agent reports through OSC 7501 once the server answers its probe; prompts, status, exit', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-'));
  const fake = path.resolve('test/fixtures/agent/fake-agent.mjs');
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: { command: process.execPath, args: [fake], commands: [{ label: 'Go', prompt: 'go {page}' }] } });
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
    assert.equal(info.body.running, false);
    assert.deepEqual(info.body.commands, [{ label: 'Go', prompt: 'go {page}' }]);
    const token: string = info.body.token;
    const auth = { 'x-redline-agent': token };

    // The guards: token, header, origin.
    assert.equal((await call('/start', {})).status, 403, 'no token');
    assert.equal((await call('/start', {}, { 'x-redline-agent': 'nope' })).status, 403, 'wrong token');
    assert.equal((await fetch(`${base}/start`, { method: 'POST', headers: auth, body: '{}' })).status, 403, 'no x-redline header');
    assert.equal((await call('/start', {}, { ...auth, origin: 'http://evil.example' })).status, 403, 'another origin');
    assert.equal((await call('/stream?token=nope')).status, 403);

    stream = sse(`${base}/stream?token=${token}`);
    assert.equal(await stream.ready, 200);
    await stream.until(e => e.event === 'hello');

    assert.equal((await call('/start', { cols: 90, rows: 20 }, auth)).status, 200);
    // The probe answered before the DA1 sentinel: the fake agent says so, and reports idle.
    await stream.until(e => e.event === 'data' && String(e.data).includes('status reporting: yes'));
    await stream.until(e => e.event === 'status' && e.data.status.source === '7501' && e.data.status.state === 'idle');

    // Allow/Deny only while it waits for approval.
    assert.equal((await call('/answer', { choice: 'allow' }, auth)).status, 409, 'not blocked');
    assert.equal((await call('/answer', { choice: 'maybe' }, auth)).status, 400);

    // A prompt that names notes: they are remembered (the panel tags them "sent"); bad ids are dropped.
    assert.equal((await call('/send', { text: 'fix the header', notes: ['n1', 'n2', '../x', 7] }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'working');
    const done = await stream.until(e => e.event === 'status' && e.data.status.state === 'done');
    assert.equal(done.data.status.msg, 'did fix the header');
    assert.deepEqual(done.data.sent, ['n1', 'n2']);
    assert.deepEqual((await call('/info')).body.sent, ['n1', 'n2']);
    assert.ok(stream.events.some(e => e.event === 'data' && String(e.data).includes('did: fix the header')), 'the prompt reached the program');

    assert.equal((await call('/ack', {}, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'idle' && e.data.running);

    // Waiting for approval: Allow sends Enter, Deny sends Esc (the defaults, Claude Code's prompt).
    assert.equal((await call('/input', { data: 'ask\r' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'blocked' && e.data.status.kind === 'permission');
    assert.equal((await call('/answer', { choice: 'allow' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'done' && e.data.status.msg === 'approved: yes');
    assert.equal((await call('/input', { data: 'ask\r' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'blocked');
    assert.equal((await call('/answer', { choice: 'deny' }, auth)).status, 200);
    await stream.until(e => e.event === 'status' && e.data.status.state === 'done' && e.data.status.msg === 'denied');

    // Keys typed in the terminal; "exit" ends it with code 3.
    assert.equal((await call('/input', { data: 'exit\r' }, auth)).status, 200);
    const exit = await stream.until(e => e.event === 'exit');
    // node-pty on Windows sometimes reports a fast exit without its code (L54): null, never a wrong one.
    assert.ok(exit.data.exitCode === 3 || (process.platform === 'win32' && exit.data.exitCode === null), `exit code ${exit.data.exitCode}`);
    assert.equal((await call('/info')).body.running, false);

    // A prompt while stopped starts the agent and waits until it is ready.
    assert.equal((await call('/send', { text: 'second' }, auth)).status, 200);
    await stream.until(e => e.event === 'data' && String(e.data).includes('did: second'));
    // Stop an idle agent: the process must survive it (a second kill() in node-pty aborted Node, L54).
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await call('/stop', {}, auth)).status, 200);
    await stream.until(e => e.event === 'exit' && stream!.events.filter(x => x.event === 'exit').length === 2);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await call('/info')).body.running, false, 'still answering after the stop');
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
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: { command: process.execPath, args: [fake] } });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  try {
    const { token } = await (await fetch(`${base}/info`)).json();
    const h = { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': token };
    assert.equal((await fetch(`${base}/start`, { method: 'POST', headers: h, body: '{}' })).status, 200);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await fetch(`${base}/stop`, { method: 'POST', headers: h, body: '{}' })).status, 200);
    await new Promise(r => setTimeout(r, 2500));
    assert.equal((await (await fetch(`${base}/info`)).json()).running, false);
  } finally { server.closeAllConnections(); server.close(); }
});

test('agent routes: only this machine, whatever the network option says; the panel is left out of its config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-agent-'));
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: true, network: true });
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
  assert.deepEqual(st('blocked', { kind: 'permission', msg: 'Edit a.ts?' }), { label: 'Needs your approval', msg: 'Edit a.ts?', color: '#ff9f0a' });
  assert.equal(st('blocked', { kind: 'question' }).label, 'Needs your answer');
  assert.equal(st('done', { msg: 'did it' }, false).label, 'Done', 'a finished run still says done');
  const sent = new Set(['a']);
  assert.equal(noteTag({ id: 'a', done: false }, sent), 'sent');
  assert.equal(noteTag({ id: 'a', done: true }, sent), 'done');
  assert.equal(noteTag({ id: 'b', done: true }, sent), null, 'done by hand, never sent: no tag');
});
