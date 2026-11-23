// Server plugins (D70): routes under <base>/p/<name>/, the API's guards, notes through the API's own path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHandler, type RedlineOptions } from '../../src/server/handler.ts';
import type { PluginContext, RedlinePlugin } from '../../src/server/plugins.ts';
import { parsePage, serializePage } from '../../src/server/format.ts';
import type { Note } from '../../src/shared/types.ts';

async function tmpRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-plugins-'));
  await fs.mkdir(path.join(root, '.git'));
  return root;
}

async function serve(root: string, opts: RedlineOptions = {}) {
  const { api } = createHandler({ ...opts, serverRoot: root, clientFile: import.meta.filename });
  const server = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__redline`;
  return { base, close: () => new Promise(r => server.close(r)) };
}

/** A plugin that echoes its route and creates/updates notes through ctx.notes. */
function probe(seen: { ctx?: PluginContext; calls: string[] }): RedlinePlugin {
  return {
    name: 'probe',
    setup(ctx) {
      seen.ctx = ctx;
      return {
        extensions: [`${ctx.base}/p/probe/ext.js`],
        async handle(req, res, p, { local }) {
          seen.calls.push(`${req.method} ${p} ${local}`);
          if (p === '/note' && req.method === 'POST') {
            const n = await ctx.notes.create({ note: { type: 'comment', page: '/x', url: 'http://h/x', body: 'from plugin', author: 'forged' } as never }, req);
            const u = await ctx.notes.update(n.id, { meta: { voice: { status: 'done' } }, body: 'changed' }, req);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ created: n, updated: u, got: await ctx.notes.get(n.id) }));
            return;
          }
          res.end('ok ' + p);
        },
      };
    },
  };
}

test('a plugin answers under /p/<name>/, gets the project paths, and its extension is listed in /config', async () => {
  const root = await tmpRepo();
  const seen: { ctx?: PluginContext; calls: string[] } = { calls: [] };
  const s = await serve(root, { plugins: [probe(seen)] });
  try {
    assert.equal(seen.ctx!.root, root);
    assert.equal(seen.ctx!.dirPath, path.join(root, '.redline'));
    assert.equal(seen.ctx!.markdown, true);
    assert.equal(seen.ctx!.base, '/__redline');
    const r = await fetch(`${s.base}/p/probe/a/b?q=1`);
    assert.equal(await r.text(), 'ok /a/b');
    assert.deepEqual(seen.calls, ['GET /a/b true']);
    assert.equal(await (await fetch(`${s.base}/p/probe`)).text(), 'ok /');
    const cfg = await (await fetch(`${s.base}/config`)).json();
    assert.deepEqual(cfg.extensions, ['/__redline/p/probe/ext.js']);
    assert.equal((await fetch(`${s.base}/p/nope/x`)).status, 404);
  } finally { await s.close(); }
});

test('plugin writes need the x-redline header; notes go through the API path with hooks, and meta can be set', async () => {
  const root = await tmpRepo();
  const seen: { calls: string[] } = { calls: [] };
  const hooks: string[] = [];
  const s = await serve(root, { plugins: [probe(seen)], build: 'abc123', hooks: { onCreate: n => { hooks.push('create ' + n.body); }, onUpdate: n => { hooks.push('update ' + n.body); } } });
  try {
    assert.equal((await fetch(`${s.base}/p/probe/note`, { method: 'POST' })).status, 403);
    assert.deepEqual(seen.calls, []);
    const r = await (await fetch(`${s.base}/p/probe/note`, { method: 'POST', headers: { 'x-redline': '1' } })).json();
    assert.equal(r.created.author, undefined, 'store-owned fields are dropped');
    assert.equal(r.created.build, 'abc123');
    assert.deepEqual(r.updated.meta, { voice: { status: 'done' } });
    assert.equal(r.got.body, 'changed');
    assert.deepEqual(hooks, ['create from plugin', 'update changed']);
    const md = await fs.readFile(path.join(root, '.redline/pages/x.md'), 'utf8');
    const [n] = parsePage(md);
    assert.deepEqual(n.meta, { voice: { status: 'done' } });
  } finally { await s.close(); }
});

test('the page cannot set meta through PATCH /notes; a plugin patch with meta: null removes it', async () => {
  const root = await tmpRepo();
  let ctx: PluginContext | undefined;
  const s = await serve(root, { plugins: [{ name: 'm', setup: c => { ctx = c; return {}; } }] });
  try {
    const n = await ctx!.notes.create({ note: { type: 'comment', page: '/', url: 'http://h/', body: 'b', meta: { a: 1 } } as never });
    await fetch(`${s.base}/notes/${n.id}`, { method: 'PATCH', headers: { 'x-redline': '1', 'content-type': 'application/json' }, body: JSON.stringify({ meta: { forged: true } }) });
    assert.deepEqual((await ctx!.notes.get(n.id))!.meta, { a: 1 });
    await ctx!.notes.update(n.id, { meta: null });
    assert.equal((await ctx!.notes.get(n.id))!.meta, undefined);
  } finally { await s.close(); }
});

test('plugin names are checked at startup', async () => {
  const root = await tmpRepo();
  const ok: RedlinePlugin = { name: 'a', setup: () => ({}) };
  assert.throws(() => createHandler({ serverRoot: root, clientFile: '', plugins: [{ name: 'Bad Name', setup: () => ({}) }] }), /lowercase/);
  assert.throws(() => createHandler({ serverRoot: root, clientFile: '', plugins: [ok, ok] }), /two plugins/);
});

test('a voice-note body (transcript + recording link) and meta round-trip through markdown', () => {
  const n: Note = {
    id: 'abc1', type: 'comment', page: '/', url: 'http://h/', at: '2026-11-23 10:00', whole: true, done: false, reply: '',
    body: 'Move the button up.\n\n🎙 [Recording (0:12)](../voice/abc1.webm)',
    meta: { voice: { audio: 'voice/abc1.webm', duration: 12.3, status: 'done', engine: 'whisper' } },
  };
  assert.deepEqual(parsePage(serializePage('/', 'http://h/', [n])), [n]);
});
