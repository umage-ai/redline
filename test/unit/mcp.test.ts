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
