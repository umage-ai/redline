// Extension points through the HTTP API: a custom store and hooks (D19), direct source
// edits (D20), and overlay extension files (D21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHandler, type RedlineOptions } from '../../src/server/handler.ts';
import { newId, stamp, type NoteStore } from '../../src/server/store.ts';
import { resolveInside } from '../../src/server/writers.ts';
import type { Note } from '../../src/shared/types.ts';

async function tmpRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-ext-'));
  await fs.mkdir(path.join(root, '.git'));
  return root;
}

async function serve(root: string, opts: RedlineOptions = {}) {
  const { api } = createHandler({ ...opts, serverRoot: root, clientFile: import.meta.filename });
  const server = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__redline`;
  const raw = (p: string, init?: RequestInit) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', 'x-redline': '1' } });
  const call = async (p: string, init?: RequestInit) => (await raw(p, init)).json();
  return { call, raw, close: () => new Promise(r => server.close(r)) };
}

function memoryStore(): NoteStore & { notes: Note[] } {
  const notes: Note[] = [];
  let v = 0;
  return {
    notes, dir: 'memory',
    async version() { return String(v); },
    async list() { return notes; },
    async create(req) { const n: Note = { ...req.note, id: newId(), at: stamp(), body: req.note.body ?? '', reply: '', done: false }; notes.push(n); v++; return n; },
    async update(id, patch) { const n = notes.find(x => x.id === id); if (!n) return null; Object.assign(n, patch); v++; return n; },
    async remove(id) { const i = notes.findIndex(x => x.id === id); if (i < 0) return false; notes.splice(i, 1); v++; return true; },
    async asset() { return null; },
  };
}

test('a custom store receives every note, hooks run after each change, no markdown is written', async () => {
  const root = await tmpRepo();
  const store = memoryStore();
  const seen: string[] = [];
  let ctx: unknown;
  const s = await serve(root, {
    store: c => { ctx = c; return store; },
    hooks: {
      onCreate: n => { seen.push(`create:${n.body}`); },
      onUpdate: (n, p) => { seen.push(`update:${n.id === store.notes[0].id}:${JSON.stringify(p)}`); },
      onRemove: () => { seen.push('remove'); throw new Error('a failing hook must not fail the request'); },
    },
  });
  try {
    assert.deepEqual(ctx, { root, dir: '.redline', app: '' });
    const n = await s.call('/notes', { method: 'POST', body: JSON.stringify({ note: { type: 'comment', page: '/', url: 'http://x/', body: 'Hi' } }) });
    assert.equal(n.body, 'Hi');
    const listed = await s.call('/notes');
    assert.equal(listed.root, 'memory');
    assert.equal(listed.notes.length, 1);
    await s.call(`/notes/${n.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    assert.equal(store.notes[0].done, true);
    assert.deepEqual(await s.call(`/notes/${n.id}`, { method: 'DELETE' }), { ok: true });
    assert.deepEqual(seen, ['create:Hi', 'update:true:{"done":true}', 'remove']);
    assert.equal((await s.raw('/assets/abc.png')).status, 404);
    await assert.rejects(fs.stat(path.join(root, '.redline/pages')));   // notes went to the custom store (only servers.json, D22)
  } finally { await s.close(); }
});

test('direct edit: off by default; dry run checks, the real run writes and calls onSourceWrite', async () => {
  const root = await tmpRepo();
  await fs.mkdir(path.join(root, 'src'));
  const page = path.join(root, 'src/Page.astro');
  await fs.writeFile(page, '---\n---\n<h1>Old title</h1>\n<p>{count}</p>\n');
  const edit = (to: string, tag = 'h1', line = 3) => JSON.stringify({ from: tag === 'h1' ? 'Old title' : '3', to, tag, url: 'http://x/', source: { file: 'src/Page.astro', line, col: 1 } });

  const off = await serve(root);
  try { assert.equal((await off.raw('/edit?dry=1', { method: 'POST', body: edit('New') })).status, 404); }
  finally { await off.close(); }

  const writes: unknown[] = [];
  const s = await serve(root, { directEdit: true, hooks: { onSourceWrite: (e, r) => { writes.push([e.to, r.file, r.line]); } } });
  try {
    assert.deepEqual(await s.call('/edit?dry=1', { method: 'POST', body: edit('New title') }), { ok: true, file: 'src/Page.astro', line: 3, writer: 'markup' });
    assert.match(await fs.readFile(page, 'utf8'), /Old title/);   // dry run wrote nothing
    assert.equal((await s.call('/edit', { method: 'POST', body: edit('New title') })).ok, true);
    assert.equal(await fs.readFile(page, 'utf8'), '---\n---\n<h1>New title</h1>\n<p>{count}</p>\n');
    assert.deepEqual(writes, [['New title', 'src/Page.astro', 3]]);
    const dyn = await s.call('/edit?dry=1', { method: 'POST', body: edit('4', 'p', 4) });
    assert.equal(dyn.ok, false);
    assert.match(dyn.reason, /expression/);
    const multi = await s.call('/edit?dry=1', { method: 'POST', body: edit('a\nb') });
    assert.match(multi.reason, /line breaks/);

    // rich: ?inspect=1 returns the source tokens; the editor's html is written as is
    await fs.writeFile(page, '<p>Keep <b class="x">this</b> bold</p>\n');
    const rich = JSON.stringify({ from: 'Keep this bold', tag: 'p', url: 'http://x/', source: { file: 'src/Page.astro', line: 1 } });
    const insp = await s.call('/edit?inspect=1', { method: 'POST', body: rich });
    assert.deepEqual(insp.inspect.tokens.map((t: { raw: string }) => t.raw), ['Keep ', '<b class="x">', 'this', '</b>', ' bold']);
    assert.equal(insp.inspect.braces, true);
    const html = 'Keep <b class="x">this</b> <i>very</i> bold';
    assert.equal((await s.call('/edit', { method: 'POST', body: JSON.stringify({ ...JSON.parse(rich), to: 'Keep this very bold', html }) })).ok, true);
    assert.equal(await fs.readFile(page, 'utf8'), `<p>${html}</p>\n`);
  } finally { await s.close(); }
});

test('direct edit: static .html pages are found from the URL; paths outside the project are refused', async () => {
  const root = await tmpRepo();
  await fs.writeFile(path.join(root, 'index.html'), '<body><h1>Agent settings</h1></body>');
  const s = await serve(root, { directEdit: true });
  try {
    const r = await s.call('/edit', { method: 'POST', body: JSON.stringify({ from: 'Agent settings', to: 'Agent options', tag: 'H1', url: 'http://localhost:5199/' }) });
    assert.deepEqual(r, { ok: true, file: 'index.html', line: 1, writer: 'static-html' });
    assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), '<body><h1>Agent options</h1></body>');
    const out = await s.call('/edit', { method: 'POST', body: JSON.stringify({ from: 'a', to: 'b', tag: 'p', url: 'http://x/', source: { file: '../elsewhere.astro', line: 1 } }) });
    assert.equal(out.ok, false);
  } finally { await s.close(); }
  assert.equal(resolveInside(root, '.redline', 'node_modules/x/a.astro'), null);
  assert.equal(resolveInside(root, '.redline', '.redline/pages/index.md'), null);
  assert.equal(resolveInside(root, '.redline', '../x.html'), null);
  assert.equal(resolveInside(root, '.redline', 'src/a.astro'), path.join(root, 'src/a.astro'));
});

test('extensions: files are served under /__redline/ext/, URLs passed through, both listed in /config', async () => {
  const root = await tmpRepo();
  await fs.writeFile(path.join(root, 'deck.ext.js'), 'export default rl => rl.addButton({ id: "x", label: "X", onClick() {} });');
  const s = await serve(root, { extensions: ['deck.ext.js', { url: '/src/other.ext.ts' }] });
  try {
    const cfg = await s.call('/config');
    assert.deepEqual(cfg.extensions, ['/__redline/ext/0.js', '/src/other.ext.ts']);
    assert.equal(cfg.directEdit, false);
    const r = await s.raw('/ext/0.js');
    assert.match(r.headers.get('content-type') ?? '', /javascript/);
    assert.match(await r.text(), /addButton/);
    assert.equal((await s.raw('/ext/1.js')).status, 404);
  } finally { await s.close(); }
});

test('direct edit: Angular templates (templateUrl .html and inline in the component .ts) treat {{ }} as code (D23)', async () => {
  const root = await tmpRepo();
  await fs.mkdir(path.join(root, 'src/app'), { recursive: true });
  const html = path.join(root, 'src/app/x.html'), ts = path.join(root, 'src/app/card.ts');
  await fs.writeFile(html, '<h2>Title {{ n }}</h2>\n<p>Use &#123;braces&#125;</p>\n<p>Hi <b *ngIf="on">there</b></p>\n');
  await fs.writeFile(ts, "@Component({\n  selector: 'c',\n  template: `\n    <h2>Card title</h2>\n  `,\n})\nexport class Card {}\n");
  const at = (file: string, line: number, tag: string, from: string, to: string) =>
    JSON.stringify({ from, to, tag, url: 'http://x/', source: { file, line, col: 1 } });
  const s = await serve(root, { directEdit: true });
  try {
    assert.match((await s.call('/edit?dry=1', { method: 'POST', body: at('src/app/x.html', 1, 'h2', 'Title 3', 'x') })).reason, /expression/);
    assert.equal((await s.call('/edit', { method: 'POST', body: at('src/app/x.html', 2, 'p', 'Use {braces}', 'Use {curly}') })).ok, true);
    assert.match(await fs.readFile(html, 'utf8'), /<p>Use &#123;curly&#125;<\/p>/);
    assert.match((await s.call('/edit?dry=1', { method: 'POST', body: at('src/app/x.html', 3, 'p', 'Hi there', 'Hi you') })).reason, /directive/);

    assert.deepEqual(await s.call('/edit', { method: 'POST', body: at('src/app/card.ts', 4, 'h2', 'Card title', 'Better title') }), { ok: true, file: 'src/app/card.ts', line: 4, writer: 'markup' });
    assert.match(await fs.readFile(ts, 'utf8'), /<h2>Better title<\/h2>/);
    assert.match((await s.call('/edit?dry=1', { method: 'POST', body: at('src/app/card.ts', 4, 'h2', 'Better title', 'A `quote`') })).reason, /inline template/);
    await fs.writeFile(path.join(root, 'src/app/util.ts'), 'export const x = "<h2>Card</h2>";\n');
    assert.match((await s.call('/edit?dry=1', { method: 'POST', body: at('src/app/util.ts', 1, 'h2', 'Card', 'y') })).reason, /no writer/);
  } finally { await s.close(); }
});
