// `redline mcp` (D22): notes as MCP tools, through a running dev server (any store) or,
// with none running, straight from the markdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { runMcp } from '../../src/mcp.ts';
import { createHandler } from '../../src/server/handler.ts';
import { createStore } from '../../src/server/store.ts';
import { readServers } from '../../src/server/registry.ts';
import { initRepo } from '../../src/init.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function tmpRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-mcp-'));
  await fs.mkdir(path.join(root, '.git'));
  return root;
}

/** An MCP client over in-memory pipes. */
function client(opts: { root: string; url?: string }) {
  const input = new PassThrough(), output = new PassThrough();
  const done = runMcp({ ...opts, input, output, version: 'test' });
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  createInterface({ input: output }).on('line', l => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  let id = 0;
  const rpc = (method: string, params?: unknown) => new Promise<Record<string, unknown>>(res => {
    waiting.set(++id, res);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc('tools/call', { name, arguments: args })).result as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  return { rpc, call, close: () => { input.end(); return done; } };
}

test('mcp: handshake and tools; without a dev server it works on the markdown directly', async () => {
  const root = await tmpRepo();
  const store = createStore({ root });
  const a = await store.create({ note: { type: 'comment', page: '/agents', url: 'http://x/agents', body: 'Make Save secondary.', target: { tag: 'button', text: 'Save', source: { file: 'src/A.tsx', line: 4 } } }, screenshot: PNG });
  await store.create({ note: { type: 'text', page: '/', url: 'http://x/', from: 'Old', to: 'New', body: '' } });
  const c = client({ root });
  try {
    const init = (await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result as Record<string, unknown>;
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.deepEqual(init.serverInfo, { name: 'redline', version: 'test' });
    assert.match(String(init.instructions), /list_notes/);
    const tools = ((await c.rpc('tools/list')).result as { tools: { name: string }[] }).tools.map(t => t.name);
    assert.deepEqual(tools, ['list_notes', 'get_note', 'update_note']);

    const list = (await c.call('list_notes')).content[0].text!;
    assert.match(list, /^2 open notes from \.redline\/ \(markdown; no dev server running\):/);
    assert.match(list, new RegExp(`- ${a.id} \\[open\\] Comment · \`button\` “Save” · src/A.tsx:4`));
    assert.match(list, /  - Old\n  \+ New/);
    assert.match((await c.call('list_notes', { page: '/agents' })).content[0].text!, /^1 open note from/);

    const got = (await c.call('get_note', { id: a.id })).content;
    assert.match(got[0].text!, /In \.redline\/pages\/agents\.md:\n\n### \[ \] Comment/);
    assert.match(got[0].text!, /Make Save secondary\./);
    assert.equal(got[1].type, 'image');
    assert.equal(got[1].data, PNG.slice(22));

    const upd = await c.call('update_note', { id: a.id, done: true, reply: 'Button is secondary now\n(A.tsx:4).' });
    assert.match(upd.content[0].text!, /\[done\][\s\S]*> Button is secondary now \(A\.tsx:4\)\./);
    assert.match(await fs.readFile(path.join(root, '.redline/pages/agents.md'), 'utf8'), /### \[x\] Comment[\s\S]*> Button is secondary now \(A\.tsx:4\)\./);

    const bad = await c.call('get_note', { id: 'nope' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text!, /no note with id nope/);
    assert.equal(((await c.rpc('nope/method')).error as { code: number }).code, -32601);
  } finally { await c.close(); }
});

test('mcp: a running dev server registers itself and is used, so a custom store works too', async () => {
  const root = await tmpRepo();
  const notes: { id: string; done: boolean; reply: string }[] = [];
  const { api } = createHandler({
    serverRoot: root, clientFile: import.meta.filename,
    store: {
      dir: 'memory',
      async version() { return String(notes.length) + notes.map(n => +n.done).join(''); },
      async list() { return notes as never; },
      async create(req) { const n = { ...req.note, id: 'mem1', at: '2026-10-15 10:00', body: req.note.body ?? '', reply: '', done: false }; notes.push(n); return n; },
      async update(id, p) { const n = notes.find(x => x.id === id); if (!n) return null; Object.assign(n, p); return n as never; },
      async remove() { return false; },
      async asset() { return null; },
    },
  });
  const server = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fetch(`${url}/__redline/notes`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: JSON.stringify({ note: { type: 'comment', page: '/', url, body: 'Hi' } }) });
  let servers = await readServers(root);
  for (let i = 0; i < 20 && !servers.length; i++) { await new Promise(r => setTimeout(r, 25)); servers = await readServers(root); }
  assert.deepEqual(servers.map(s => s.url), [url]);

  const c = client({ root });
  try {
    assert.match((await c.call('list_notes')).content[0].text!, new RegExp(`^1 open note from dev server ${url}:`));
    await c.call('update_note', { id: 'mem1', done: true, reply: 'Done.' });
    assert.deepEqual(notes.map(n => [n.done, n.reply]), [[true, 'Done.']]);
    await fs.rm(path.join(root, '.redline'), { recursive: true, force: true });
  } finally { await c.close(); await new Promise(r => server.close(r)); }

  // --url pointing nowhere: a clear error, not a silent fallback to files
  const d = client({ root, url: 'http://127.0.0.1:9' });
  try { assert.match((await d.call('list_notes')).content[0].text!, /no Redline dev server at http:\/\/127\.0\.0\.1:9/); }
  finally { await d.close(); }
});

test('init --mcp: registers the server in .mcp.json and per agent, keeping existing config', async () => {
  const root = await tmpRepo();
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  await fs.mkdir(path.join(root, '.cursor'));
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode/mcp.json'), '{ not json');
  const mcp = { command: 'node', args: ['node_modules/@umage.ai/redline/dist/cli.js', 'mcp'] };
  const log = await initRepo(root, { skill: '# s\n', harnesses: ['claude', 'copilot'], mcp });
  const read = async (f: string) => JSON.parse(await fs.readFile(path.join(root, f), 'utf8'));
  assert.deepEqual(await read('.mcp.json'), { mcpServers: { other: { command: 'x' }, redline: mcp } });
  assert.deepEqual(await read('.cursor/mcp.json'), { mcpServers: { redline: mcp } });
  assert.equal(await fs.readFile(path.join(root, '.vscode/mcp.json'), 'utf8'), '{ not json');   // left alone
  assert.ok(log.some(l => l.startsWith('! .vscode/mcp.json')));
  assert.ok(!log.some(l => l.includes('.gemini')));
  const again = await initRepo(root, { skill: '# s\n', harnesses: ['claude'], mcp });
  assert.ok(again.includes('· .mcp.json: MCP server up to date'));
});

/* ---------- HTTP endpoint on the dev server (D37) ---------- */

async function serveHandler(root: string, opts: Parameters<typeof createHandler>[0] extends infer O ? Partial<O> : never = {}) {
  const { api } = createHandler({ serverRoot: root, clientFile: import.meta.filename, ...opts });
  const server = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__redline/mcp`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { url, post, close: () => new Promise(r => server.close(r)) };
}

test('mcp over HTTP: POST /__redline/mcp serves the same tools on the handler\'s store, stateless', async () => {
  const root = await tmpRepo();
  const updated: string[] = [];
  const store = createStore({ root });
  const a = await store.create({ note: { type: 'comment', page: '/x', url: 'http://x/x', body: 'Bigger.', target: { tag: 'h1', text: 'Hi' } }, screenshot: PNG });
  const s = await serveHandler(root, { hooks: { onUpdate: n => { updated.push(n.id); } } });
  try {
    const init = await (await s.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json();
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'redline');
    const note = await s.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), '');
    const tools = await (await s.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    assert.deepEqual(tools.result.tools.map((t: { name: string }) => t.name), ['list_notes', 'get_note', 'update_note']);

    const call = async (name: string, args: object) => (await (await s.post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })).json()).result;
    assert.match((await call('list_notes', {})).content[0].text, /^1 open note from dev server http:\/\/127\.0\.0\.1:\d+:/);
    const got = await call('get_note', { id: a.id });
    assert.equal(got.content[1].type, 'image');
    assert.equal((await call('get_note', { id: 'nope' })).isError, true);
    await call('update_note', { id: a.id, done: true, reply: 'Made it 2rem.' });
    assert.deepEqual(updated, [a.id]);   // hooks run as for the overlay's PATCH
    assert.equal((await store.list())[0].done, true);

    // batches answer in one array; unknown methods are JSON-RPC errors; bad JSON is a parse error
    const batch = await (await s.post([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'nope' }, { jsonrpc: '2.0', method: 'notifications/x' }])).json();
    assert.deepEqual(batch.map((r: { id: string }) => r.id), ['a', 'b']);
    assert.equal(batch[1].error.code, -32601);
    assert.equal((await (await s.post('{oops')).json()).error.code, -32700);

    assert.equal((await fetch(s.url)).status, 405);   // no SSE stream
    // no x-redline header needed, but a page on another origin is refused (DNS rebinding)
    assert.equal((await s.post({ jsonrpc: '2.0', id: 4, method: 'ping' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await s.post({ jsonrpc: '2.0', id: 4, method: 'ping' }, { origin: new URL(s.url).origin })).status, 200);
    // without mcpTokens a bearer token is not accepted either (it would mean the caller expects auth)
    assert.equal((await s.post({ jsonrpc: '2.0', id: 4, method: 'ping' }, { authorization: 'Bearer x' })).status, 401);
  } finally { await s.close(); }
});

test('mcp over HTTP: mcpTokens require a bearer token (plain or sha256:), even locally', async () => {
  const root = await tmpRepo();
  const { createHash } = await import('node:crypto');
  const s = await serveHandler(root, { mcpTokens: ['rl_plain', 'sha256:' + createHash('sha256').update('rl_hashed').digest('hex')] });
  const ping = (auth?: string) => s.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, auth ? { authorization: auth } : {});
  try {
    const none = await ping();
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
    assert.equal((await ping('Bearer wrong')).status, 401);
    assert.equal((await ping('Bearer rl_plain')).status, 200);
    assert.equal((await ping('bearer rl_hashed')).status, 200);
  } finally { await s.close(); }
});

test('mcpAllowed: without tokens only loopback callers', async () => {
  const { mcpAllowed } = await import('../../src/server/handler.ts');
  const req = (remoteAddress: string, authorization?: string) => ({ headers: { authorization }, socket: { remoteAddress } }) as never;
  assert.equal(mcpAllowed(req('127.0.0.1'), undefined), true);
  assert.equal(mcpAllowed(req('::1'), []), true);
  assert.equal(mcpAllowed(req('::ffff:127.0.0.1'), undefined), true);
  assert.equal(mcpAllowed(req('192.168.1.20'), undefined), false);   // `vite --host`: LAN callers need a token
  assert.equal(mcpAllowed(req('192.168.1.20', 'Bearer t'), ['t']), true);
  assert.equal(mcpAllowed(req('192.168.1.20', 'Bearer t'), ['sha256:zz']), false);   // a malformed hash never matches
});
