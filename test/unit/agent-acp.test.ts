// The agent panel's ACP mode (D58): the JSON-RPC client (id 0, L58), a permission request as the
// card's menu, which CLIs use it, and the HTTP flow end to end with a fake ACP agent
// (test/fixtures/agent/fake-acp-agent.mjs) over stdio: prompt → working → done, a permission →
// blocked → menu → answer, End mid-turn, a crashed agent → failed, a failed handshake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { JsonRpc, permissionView, usesAcp } from '../../agent-bridge/src/acp.ts';
import { agent } from '../../agent/src/index.ts';
import { createHandler } from '../../src/server/handler.ts';
import type { AgentOptions } from '../../src/server/agent-hook.ts';

const FAKE = path.resolve('test/fixtures/agent/fake-acp-agent.mjs');

test('JsonRpc: requests both ways, notifications, errors; an agent request with id 0 is answered (L58)', async () => {
  const out: any[] = [];
  const rpc = new JsonRpc(line => out.push(JSON.parse(line)));
  const seen: string[] = [];
  rpc.onNotification = (m, p) => seen.push(`${m}:${p.x}`);
  rpc.onRequest = (m, p) => { if (m === 'boom') throw Object.assign(new Error('no'), { code: -32601 }); return { echo: p.v }; };
  const r = rpc.request('initialize', { a: 1 });
  assert.deepEqual(out[0], { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
  rpc.feed('not json\n{"jsonrpc":"2.0","id":1,"res');
  rpc.feed('ult":{"ok":true}}\n{"jsonrpc":"2.0","method":"session/update","params":{"x":5}}\n');
  assert.deepEqual(await r, { ok: true });
  assert.deepEqual(seen, ['session/update:5']);
  rpc.feed('{"jsonrpc":"2.0","id":0,"method":"ask","params":{"v":"zero"}}\n{"jsonrpc":"2.0","id":"s","method":"boom"}\n');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(out.find(o => o.id === 0), { jsonrpc: '2.0', id: 0, result: { echo: 'zero' } }, 'id 0 is a request, not a notification');
  assert.deepEqual(out.find(o => o.id === 's'), { jsonrpc: '2.0', id: 's', error: { code: -32601, message: 'no' } });
  const e = rpc.request('x', {});
  rpc.feed(`{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}\n`);
  await assert.rejects(e, (err: Error & { code?: number }) => err.message === 'Authentication required' && err.code === -32000);
  const late = rpc.request('y', {});
  rpc.close('gone');
  await assert.rejects(late, /gone/);
  await assert.rejects(rpc.request('z', {}), /exited/);
});

test('permissionView: the request as the card shows it (OpenCode 2.2.6 shell request, a diff)', () => {
  // As captured from `opencode acp` (permission: { bash: 'ask' }).
  const v = permissionView({
    sessionId: 'ses_x', toolCall: { toolCallId: 'c1', name: 'shell', title: 'echo hello-redline', kind: 'execute', status: 'pending', locations: [{ path: 'C:\\repo' }], rawInput: { command: 'echo hello-redline', cwd: 'C:\\repo' } },
    options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }],
  });
  assert.equal(v.question, 'Allow execute: echo hello-redline?');
  assert.deepEqual(v.options.map(o => o.label), ['Allow once', 'Always allow', 'Reject']);
  assert.deepEqual(v.lines, [[{ t: '$ echo hello-redline' }]]);
  const d = permissionView({ toolCall: { title: 'Edit App.tsx', kind: 'edit', content: [{ type: 'diff', path: 'src/App.tsx', oldText: 'a', newText: 'b' }] }, options: [] });
  assert.deepEqual(d.lines.map(l => l[0].t), ['src/App.tsx', '- a', '+ b']);
  assert.ok(d.lines[2][0].bg, 'added lines keep a colour');
});

test('usesAcp: OpenCode speaks ACP by default, Claude Code a terminal; `protocol` decides', () => {
  assert.equal(usesAcp({ command: 'opencode' }), true);
  assert.equal(usesAcp({ command: 'C:\\npm\\opencode.cmd' }), true);
  assert.equal(usesAcp({ command: 'opencode', protocol: 'pty' }), false);
  assert.equal(usesAcp({ command: 'claude' }), false);
  assert.equal(usesAcp({ command: 'my-agent', protocol: 'acp' }), true);
  assert.equal(usesAcp({}), false);
});

/** An SSE reader: the events so far, and a wait for one that matches. */
function sse(url: string) {
  const events: { event: string; data: any }[] = [];
  const waiters: (() => void)[] = [];
  let req!: http.ClientRequest;
  const ready = new Promise<number>((resolve, reject) => {
    req = http.get(url, res => {
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
  async function until(pred: (e: { event: string; data: any }) => boolean, ms = 20_000, from = 0) {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events.map(e => e.event === 'data' ? 'data' : `${e.event}:${JSON.stringify(e.data.status ?? e.data.sessions?.map((s: any) => [s.id, s.running, s.status]) ?? e.data)}`))}`);
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 200); });
    }
  }
  return { events, ready, until, mark: () => events.length, close: () => req.destroy() };
}

async function serve(opts: AgentOptions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-acp-'));
  const { api } = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, agent: agent({ command: process.execPath, args: [FAKE], protocol: 'acp', ...opts }) });
  const server = http.createServer((rq, rs) => api(rq, rs, () => { rs.statusCode = 404; rs.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}/__redline/agent`;
  const { token } = await (await fetch(`${base}/info`)).json();
  const call = async (p: string, body: unknown = {}) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const feed = sse(`${base}/stream?status=1&token=${token}`);
  type S = { id: string; running: boolean; app?: string; protocol?: string; exitCode?: number | null; status: { state: string; kind?: string; msg?: string; source: string }; prompt?: { question?: string; options: { label: string }[]; lines: { t: string }[][] }; sent: string[] };
  /** The first status from event `from` on (`feed.mark()` before the action) whose sessions match. */
  const when = (pred: (ss: S[]) => boolean, from = 0) => feed.until(e => (e.event === 'status' || e.event === 'hello') && pred(e.data.sessions), undefined, from);
  const close = async () => {
    feed.close();
    await call('/end', {}).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    server.closeAllConnections();
    server.close();
  };
  return { base, token, call, feed, when, close };
}
type Srv = Awaited<ReturnType<typeof serve>>;

test('ACP routes: prompt → working → done with the transcript, the model set, permission → menu → answer, typed lines', { timeout: 60_000 }, async () => {
  const t: Srv = await serve({ sessions: 'shared', model: 'fake/two', instructions: 'House rules.' });
  let term: ReturnType<typeof sse> | undefined;
  try {
    assert.equal(await t.feed.ready, 200);
    // A prompt starts the agent (spawn, initialize, session/new, the model) and goes as session/prompt.
    assert.deepEqual((await t.call('/send', { text: 'fix the header', notes: ['n1'] })).body, { ok: true, id: 's1' });
    const done = await t.when(ss => ss[0]?.status.state === 'done');
    const s = done.data.sessions[0];
    assert.deepEqual([s.protocol, s.app, s.status.source, s.running, s.sent], ['acp', 'FakeACP', 'acp', true, ['n1']]);
    assert.equal(s.status.msg, 'fix the header', 'the last line of its reply (after the instructions, sent as a preamble)');
    assert.ok(t.feed.events.some(e => e.event === 'status' && e.data.sessions[0]?.status.state === 'working'), 'working while the prompt runs');

    // The CLI window: a transcript in ANSI text.
    term = sse(`${t.base}/stream?id=s1&token=${t.token}`);
    const hello = await term.until(e => e.event === 'hello');
    const text = hello.data.scrollback as string;
    assert.match(text, /› .*fix the header/);
    assert.match(text, /Read src\/App\.tsx/, 'tool calls by title');
    assert.match(text, /model fake\/two/, 'the model option went through session/set_config_option');
    assert.match(text, /did House rules\.\r\n\r\nfix the header/, 'the instructions ahead of the first prompt only');

    let m = t.feed.mark();
    await t.call('/ack');
    await t.when(ss => ss[0]?.status.state === 'idle', m);

    // A permission request: blocked, the agent's options as the card's menu; /choose answers with the optionId.
    assert.equal((await t.call('/choose', { index: 0 })).status, 409, 'nothing asked yet');
    m = t.feed.mark();
    await t.call('/send', { text: 'ask once' });
    const asked = await t.when(ss => ss[0]?.status.state === 'blocked', m);
    const a = asked.data.sessions[0];
    assert.equal(a.status.kind, 'permission');
    assert.equal(a.prompt!.question, 'Allow execute: echo hello?');
    assert.deepEqual(a.prompt!.options.map((o: { label: string }) => o.label), ['Allow once', 'Always allow', 'Reject']);
    assert.equal((await t.call('/choose', { index: 2 })).status, 200);
    const rejected = await t.when(ss => ss[0]?.status.state === 'done', m);
    assert.equal(rejected.data.sessions[0].status.msg, 'did ask once: reject');
    assert.equal(rejected.data.sessions[0].prompt, undefined, 'the menu is gone once answered');

    // Allow/Deny map to the agent's first allow / reject option.
    m = t.feed.mark();
    await t.call('/send', { text: 'ask again' });
    await t.when(ss => ss[0]?.status.state === 'blocked', m);
    assert.equal((await t.call('/answer', { choice: 'allow' })).status, 200);
    await t.when(ss => ss[0]?.status.msg === 'did ask again: once');

    // A line typed in the CLI window (echoed) is a prompt; Esc on a question cancels the turn.
    const tm = term.mark();
    await t.call('/input', { data: 'plan b\r' });
    await term.until(e => e.event === 'data' && String(e.data).includes('Plan'), undefined, tm);
    await t.when(ss => ss[0]?.status.msg === 'did plan b');
    m = t.feed.mark();
    await t.call('/send', { text: 'ask three' });
    await t.when(ss => ss[0]?.status.state === 'blocked', m);
    await t.call('/input', { data: '\x1b' });
    const cancelled = await t.feed.until(e => e.event === 'status' && e.data.sessions[0]?.status.msg === 'cancelled', undefined, m);
    assert.equal(cancelled.data.sessions[0].status.state, 'idle');
    assert.equal(cancelled.data.sessions[0].running, true);
  } finally { term?.close(); await t.close(); }
});

test('ACP routes: End mid-turn (and mid-question) stops the agent and closes the session', { timeout: 30_000 }, async () => {
  const t: Srv = await serve({ sessions: 'fresh' });
  try {
    await t.feed.ready;
    const { body } = await t.call('/send', { text: 'slow' });
    await t.when(ss => ss.find(x => x.id === body.id)?.status.state === 'working');
    assert.equal((await t.call('/end', { id: body.id })).status, 200);
    await t.when(ss => !ss.some(x => x.id === body.id));
    const two = await t.call('/send', { text: 'ask' });
    await t.when(ss => ss.find(x => x.id === two.body.id)?.status.state === 'blocked');
    assert.equal((await t.call('/stop', { id: two.body.id })).status, 200);
    const stopped = await t.when(ss => ss.find(x => x.id === two.body.id)?.running === false);
    const s = stopped.data.sessions.find((x: { id: string }) => x.id === two.body.id);
    assert.equal(s.status.state, 'idle', 'stopped on purpose: not failed');
    assert.equal(s.prompt, undefined);
  } finally { await t.close(); }
});

test('ACP routes: a crashed agent shows as failed with its exit code; a failed handshake fails the start', { timeout: 30_000 }, async () => {
  const t: Srv = await serve({ sessions: 'shared' });
  try {
    await t.feed.ready;
    await t.call('/send', { text: 'crash now' });
    const failed = await t.when(ss => ss[0]?.status.state === 'error');
    const s = failed.data.sessions[0];
    assert.equal(s.running, false);
    assert.equal(s.exitCode, 7);
    assert.match(s.status.msg, /exited with code 7: fake acp agent starting/);
    // The next prompt starts it again.
    await t.call('/send', { text: 'again' });
    await t.when(ss => ss[0]?.status.state === 'done' && ss[0].status.msg === 'did again');
  } finally { await t.close(); }

  const bad: Srv = await serve({ env: { FAKE_ACP_FAIL_INIT: '1' } });
  try {
    const r = await bad.call('/start', {});
    assert.equal(r.status, 500);
    assert.match(r.body.error, /Authentication required \(log the CLI in first/);
    await bad.when(ss => ss[0]?.running === false && ss[0].status.state === 'error');
  } finally { await bad.close(); }
});

test('ACP settings (D62): the agent is asked once for its models and effort levels; only those reach session/set_config_option', { timeout: 60_000 }, async () => {
  const t: Srv = await serve({ sessions: 'shared' });
  let term: ReturnType<typeof sse> | undefined;
  try {
    // The first /info (serve's) started the probe in the background: the lists arrive on the feed and in /info.
    type C = { models: { value: string; name?: string }[]; efforts: { value: string; name?: string }[]; pending?: boolean };
    let cli: C | undefined;
    for (let i = 0; i < 100 && !(cli && !cli.pending); i++) {
      cli = (await (await fetch(`${t.base}/info`)).json()).clis[0];
      if (cli?.pending) await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(cli!.models, [{ value: 'fake/one', name: 'Fake One' }, { value: 'fake/two', name: 'Fake Two' }]);
    assert.deepEqual(cli!.efforts, [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }], 'its "default" is the settings\' own Default');
    assert.equal((await t.call('/send', { text: 'x', model: 'fake/three' })).status, 400);
    assert.equal((await t.call('/send', { text: 'x', effort: 'max' })).status, 400);
    assert.deepEqual((await t.call('/send', { text: 'fix it', model: 'fake/two', effort: 'high' })).body, { ok: true, id: 's1' });
    const done = await t.when(ss => ss[0]?.status.state === 'done');
    assert.deepEqual([done.data.sessions[0].model, done.data.sessions[0].effort], ['fake/two', 'high']);
    term = sse(`${t.base}/stream?id=s1&token=${t.token}`);
    const hello = await term.until(e => e.event === 'hello');
    assert.match(hello.data.scrollback as string, /model fake\/two effort high/, 'both set through session/set_config_option');
  } finally { term?.close(); await t.close(); }
});
