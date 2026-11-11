// The dev server's own MCP tools (D65, D66) over POST /__redline/mcp: live pages (check_page,
// page_console, note_dom, answered by an open tab over GET /__redline/live), and agent sessions
// (working_on, attach, list_agent_sessions, get_agent_session) for the sessions Redline starts, which
// get the endpoint wired in (Claude Code --mcp-config, ACP session/new) with their own bearer and id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../../src/server/handler.ts';
import { agent } from '../../agent/src/index.ts';
import { claudeCode } from '../../agent-bridge/src/adapters.ts';
import { MCP_TOKEN } from '../../agent/src/server.ts';

async function serve(opts: Record<string, unknown> = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'redline-mcp-live-')));
  const h = createHandler({ root, serverRoot: root, clientFile: import.meta.filename, ...opts });
  const server = http.createServer((rq, rs) => h.api(rq, rs, () => { rs.statusCode = rq.url === '/settings' ? 200 : 404; rs.setHeader('content-type', 'text/html'); rs.end('<p>page</p>'); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${(server.address() as { port: number }).port}`;
  let n = 0;
  const mcp = async (name: string, args: object = {}, headers: Record<string, string> = {}) => {
    const r = await fetch(`${url}/__redline/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }) });
    if (r.status !== 200) return { status: r.status, text: '', isError: true };
    const j = await r.json();
    return { status: 200, text: j.result.content.map((c: { text?: string }) => c.text ?? '').join('\n') as string, isError: !!j.result.isError };
  };
  const tools = async (headers: Record<string, string> = {}) => (await (await fetch(`${url}/__redline/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) })).json()).result.tools.map((t: { name: string }) => t.name);
  return { root, url, h, mcp, tools, close: () => server.close() };
}

/** A browser tab with the overlay, as far as the server can tell: the live stream, answered like live.ts does. */
async function tab(url: string, page: string, answer: (a: { kind: string; target?: unknown }) => unknown) {
  const ac = new AbortController();
  const r = await fetch(`${url}/__redline/live?page=${encodeURIComponent(page)}&path=${encodeURIComponent(page)}&title=T`, { signal: ac.signal });
  assert.equal(r.status, 200);
  const reader = r.body!.getReader(), dec = new TextDecoder();
  let buf = '', conn = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev === 'hello') conn = JSON.parse(data!).id;
          if (ev === 'ask') {
            const a = JSON.parse(data!);
            await fetch(`${url}/__redline/live/reply`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: JSON.stringify({ conn, req: a.req, data: answer(a) }) });
          }
        }
      }
    } catch { /* closed */ }
  })();
  for (let t = 0; !conn && t < 50; t++) await new Promise(res => setTimeout(res, 20));
  return { close: () => ac.abort() };
}

test('live pages: page_console, note_dom and check_page ask the open tabs; with none open, they say so', async () => {
  const s = await serve();
  try {
    assert.deepEqual(await s.tools(), ['list_notes', 'get_note', 'update_note', 'check_page', 'page_console', 'note_dom'], 'no agent: no session tools');
    assert.match((await s.mcp('page_console')).text, /No browser tab has this app open/);
    const note = await s.h.store.create({ note: { page: '/settings', type: 'comment', body: 'Bigger', target: { selector: 'button.save', tag: 'button', text: 'Save' } } } as never);
    assert.match((await s.mcp('note_dom', { id: note.id })).text, /No open tab shows the note's page \(\/settings\)/);

    const t = await tab(s.url, '/settings', a => a.kind === 'console' ? { errors: ['TypeError: x is undefined'] } : { element: 'button.save', text: 'Save', ancestors: ['main', 'form'] });
    const c = await s.mcp('page_console');
    assert.match(c.text, /\/settings: 1 console error\n  - TypeError: x is undefined/);
    const d = await s.mcp('note_dom', { id: note.id });
    assert.match(d.text, /"element": "button.save"/);
    const chk = await s.mcp('check_page', { path: '/settings' });
    assert.match(chk.text, /GET \/settings → 200 \(text\/html, 11 bytes\)/);
    assert.match(chk.text, /TypeError: x is undefined/);
    assert.match((await s.mcp('check_page', { path: '/missing' })).text, /→ 404[\s\S]*No open tab shows \/missing/);
    assert.equal((await s.mcp('check_page', { path: 'http://evil.example/' })).isError, true, 'its own pages only');
    // The element gone from the page: said plainly.
    t.close();
    const gone = await tab(s.url, '/settings', () => ({ missing: true, url: 'x' }));
    assert.match((await s.mcp('note_dom', { id: note.id })).text, /isn't on \/settings now/);
    gone.close();
  } finally { s.close(); }
});

test('live pages: this machine only; a reply needs the x-redline header', async () => {
  const s = await serve({ network: true });
  try {
    const remote = await new Promise<number>(resolve => {
      const res = { statusCode: 0, setHeader() {}, end() { resolve(res.statusCode); }, writeHead() {}, write() {}, on() {} };
      s.h.api({ url: '/__redline/live?page=/', method: 'GET', headers: { host: '192.168.1.2:5173' }, socket: { remoteAddress: '192.168.1.9' }, on() {} } as never, res as never, () => resolve(-1));
    });
    assert.equal(remote, 404);
    assert.equal((await fetch(`${s.url}/__redline/live/reply`, { method: 'POST', body: '{}' })).status, 403);
  } finally { s.close(); }
});

test('agent sessions over MCP: Redline wires its MCP into the sessions it starts; working_on, attach, the session tools', { timeout: 60_000 }, async () => {
  const fake = path.resolve('test/fixtures/agent/fake-acp-agent.mjs');
  const s = await serve({ agent: agent({ command: process.execPath, args: [fake], protocol: 'acp', sessions: 'fresh' }) });
  try {
    const info = await (await fetch(`${s.url}/__redline/agent/info`)).json();
    const post = (p: string, body: object) => fetch(`${s.url}/__redline/agent${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': info.token }, body: JSON.stringify(body) }).then(r => r.json());
    const note = await s.h.store.create({ note: { page: '/', type: 'comment', body: 'Fix the header' } } as never);
    await fs.writeFile(path.join(s.root, 'shot.png'), 'png');
    const { id } = await post('/send', { text: 'hello', notes: [note.id], title: 'Header' });
    let tail = '';
    for (let t = 0; t < 100 && !/mcp redline/.test(tail); t++) { await new Promise(r => setTimeout(r, 100)); tail = (await s.mcp('get_agent_session', { id })).text; }
    // ACP session/new got the dev server's MCP over HTTP, with its bearer and its id.
    assert.match(tail, new RegExp(`mcp redline http ${s.url.replace(/[.:/]/g, c => '\\' + c)}/__redline/mcp authorization,x-redline-agent-session`));

    // As that session: its bearer (never given to pages) and its id. Agent tools listed, instructions say how.
    const token = MCP_TOKEN;
    const as = { authorization: `Bearer ${token}`, 'x-redline-agent-session': id };
    assert.ok((await s.tools(as)).includes('working_on'));
    assert.match((await s.mcp('working_on', { id: note.id }, as)).text, /is on note/);
    let sess = (await (await fetch(`${s.url}/__redline/agent/info`)).json()).sessions[0];
    assert.equal(sess.focus, note.id);
    assert.match((await s.mcp('attach', { path: 'shot.png', title: 'After' }, as)).text, /Attached shot\.png \(image\)/);
    assert.equal((await s.mcp('attach', { path: '../etc/passwd' }, as)).isError, true);
    sess = (await (await fetch(`${s.url}/__redline/agent/info`)).json()).sessions[0];
    assert.equal(sess.attachments, 1);
    const list = await s.mcp('list_agent_sessions', {}, as);
    assert.match(list.text, new RegExp(`you are ${id}`));
    assert.match(list.text, new RegExp(`notes: ${note.id} · on: ${note.id}`));
    // Without a session (a CLI Redline didn't start), the session tools say how to name one.
    assert.match((await s.mcp('working_on', { id: null })).text, /no agent session/);
    assert.match((await s.mcp('working_on', { id: null, session: id })).text, /no note now/);
    // A wrong bearer is not the agent's: with no mcpTokens a bearer is refused outright.
    assert.equal((await s.mcp('list_agent_sessions', {}, { authorization: 'Bearer nope', 'x-redline-agent-session': id })).status, 401);
    await post('/end', {});
  } finally { s.close(); }
});

test('Claude Code gets the MCP servers as an --mcp-config file (owner-only, removed at exit)', async () => {
  const r = await claudeCode.start!({ args: ['-c'], instructions: { text: '' }, mcp: [{ name: 'redline', url: 'http://localhost:5173/__redline/mcp', headers: { authorization: 'Bearer t', 'x-redline-agent-session': 's1' } }] });
  assert.deepEqual(r.args.slice(0, 2), ['-c', '--mcp-config']);
  const cfg = JSON.parse(await fs.readFile(r.args[2], 'utf8'));
  assert.deepEqual(cfg, { mcpServers: { redline: { type: 'http', url: 'http://localhost:5173/__redline/mcp', headers: { authorization: 'Bearer t', 'x-redline-agent-session': 's1' } } } });
  const none = await claudeCode.start!({ args: [], instructions: { text: '' } });
  assert.deepEqual(none.args, [], 'no MCP servers: no flag');
});
