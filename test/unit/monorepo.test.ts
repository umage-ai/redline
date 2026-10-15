// Monorepos (D17): one .redline/ at the repo root, notes tagged with the app that wrote them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { appOf, findRoot } from '../../src/server/root.ts';
import { createHandler } from '../../src/server/handler.ts';
import { pageFile, parsePage, serializePage } from '../../src/server/format.ts';
import type { Note } from '../../src/shared/types.ts';

async function monorepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-mono-'));
  await fs.mkdir(path.join(root, '.git'));
  for (const app of ['apps/web', 'apps/admin']) {
    await fs.mkdir(path.join(root, app, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, app, 'src/App.tsx'), 'export {}\n');
  }
  return root;
}

/** A dev server for one app: the handler's API on a random port. */
async function serve(serverRoot: string) {
  const { api } = createHandler({ serverRoot, clientFile: import.meta.filename });
  const server = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__redline`;
  const call = async (p: string, init?: RequestInit) => (await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', 'x-redline': '1' } })).json();
  return { call, close: () => new Promise(r => server.close(r)) };
}

test('appOf: the dev server folder relative to the root, "" at or outside it', async () => {
  const root = await monorepo();
  assert.equal(appOf(root, path.join(root, 'apps/web')), 'apps/web');
  assert.equal(appOf(root, root), '');
  assert.equal(appOf(path.join(root, 'apps/web'), root), '');
  assert.equal(findRoot(path.join(root, 'apps/web/src')), root);
});

test('two apps share one .redline/ without colliding on the same path; each knows its app', async () => {
  const root = await monorepo();
  const web = await serve(path.join(root, 'apps/web'));
  const admin = await serve(path.join(root, 'apps/admin'));
  try {
    assert.equal((await web.call('/config')).app, 'apps/web');
    const note = (body: string) => ({ method: 'POST', body: JSON.stringify({ note: { type: 'comment', page: '/', url: 'http://x/', body, target: { source: { file: 'src/App.tsx', line: 3 } } } }) });
    const a = await web.call('/notes', note('web home'));
    const b = await admin.call('/notes', note('admin home'));
    assert.equal(a.file, '.redline/pages/apps-web--index.md');
    assert.equal(b.file, '.redline/pages/apps-admin--index.md');
    assert.equal(a.target.source.file, 'apps/web/src/App.tsx');   // repo-relative, so an agent at the root finds it
    const listed = (await web.call('/notes')).notes as Note[];
    assert.deepEqual(listed.map(n => [n.app, n.body]).sort(), [['apps/admin', 'admin home'], ['apps/web', 'web home']]);
    const index = await fs.readFile(path.join(root, '.redline/INDEX.md'), 'utf8');
    assert.match(index, /\| App \| Page \|/);
    assert.match(index, /\| `apps\/web` \| `\/` \| 1 \| 0 \| \[pages\/apps-web--index\.md\]/);
    assert.match(await fs.readFile(path.join(root, '.redline/pages/apps-web--index.md'), 'utf8'), /^# Redline — apps\/web · \//);
    assert.equal(existsSync(path.join(root, 'apps/web/.redline')), false);
  } finally { await web.close(); await admin.close(); }
});

test('the app is set by the server, not the page, and survives the markdown round-trip', async () => {
  const root = await monorepo();
  const web = await serve(path.join(root, 'apps/web'));
  try {
    const n = await web.call('/notes', { method: 'POST', body: JSON.stringify({ note: { type: 'comment', page: '/x', url: 'http://x/x', body: 'hi', app: 'apps/evil' } }) });
    assert.equal(n.app, 'apps/web');
  } finally { await web.close(); }
  const note: Note = { id: 'abc123', type: 'comment', page: '/x', app: 'apps/web', url: 'http://x/x', at: '2026-10-15 10:00', body: 'hi', reply: '', done: false };
  assert.deepEqual(parsePage(serializePage('/x', note.url, [note])), [note]);
  assert.equal(pageFile('/x'), 'x.md');                         // single-app repos keep their file names
});
