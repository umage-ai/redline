// Note labels (D46): the option as /config hands it to the overlay, and the label a page sends,
// cleaned before it reaches the store and the markdown heading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHandler, type RedlineOptions } from '../../src/server/handler.ts';
import { createStore } from '../../src/server/store.ts';
import { remoteStore } from '../../src/server/remote.ts';
import { cleanLabel, DEFAULT_LABELS, normalizeLabels } from '../../src/shared/labels.ts';

async function serve(opts: RedlineOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-labels-'));
  await fs.mkdir(path.join(root, '.git'));
  const { api } = createHandler({ ...opts, serverRoot: root, clientFile: import.meta.filename });
  const server = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__redline`;
  const call = async (p: string, init?: RequestInit) => (await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', 'x-redline': '1' } })).json();
  return { root, base, call, close: () => new Promise(r => server.close(r)) };
}

test('labels option: defaults, off, names or { name, color }, cleaned and deduplicated', () => {
  assert.deepEqual(normalizeLabels(undefined), DEFAULT_LABELS);
  assert.deepEqual(DEFAULT_LABELS.map(l => l.name), ['Bug', 'UX', 'Idea', 'Copy']);
  assert.deepEqual(normalizeLabels(false), []);
  assert.deepEqual(normalizeLabels([]), []);
  assert.deepEqual(normalizeLabels([' Bug ', { name: 'Perf', color: ' #0c0 ' }, 'bug', '', { name: '  ' }, 'Needs\n  design', { name: 'A11y', color: '' }]), [
    { name: 'Bug' }, { name: 'Perf', color: '#0c0' }, { name: 'Needs design' }, { name: 'A11y' },
  ]);
  assert.equal(cleanLabel('x'.repeat(40)), 'x'.repeat(30));
  assert.equal(cleanLabel(42), '');
});

test('/config hands the overlay its labels', async () => {
  for (const [labels, want] of [[undefined, DEFAULT_LABELS], [false, []], [['Bug', { name: 'Perf', color: 'teal' }], [{ name: 'Bug' }, { name: 'Perf', color: 'teal' }]]] as const) {
    const s = await serve({ labels: labels as RedlineOptions['labels'] });
    try { assert.deepEqual((await s.call('/config')).labels, want); }
    finally { await s.close(); }
  }
});

test('a note keeps its label, cleaned; it leads the markdown heading; junk is dropped', async () => {
  const s = await serve();
  try {
    const post = (label: unknown) => s.call('/notes', { method: 'POST', body: JSON.stringify({ note: { type: 'comment', page: '/', url: 'http://x/', body: 'Hi', label } }) });
    assert.equal((await post('  Bug \n')).label, 'Bug');
    assert.equal((await post(42)).label, undefined);
    assert.equal((await post('   ')).label, undefined);
    const md = await fs.readFile(path.join(s.root, '.redline/pages/index.md'), 'utf8');
    assert.match(md, /^### \[ \] Bug · Comment · whole page$/m);
    assert.equal(md.match(/^### \[ \] Comment · whole page$/gm)?.length, 2);
  } finally { await s.close(); }
});

test('labels from a function: asked per request with it, may be async; a failure shows none', async () => {
  const s = await serve({ labels: async ({ req }) => req.headers['x-team'] === 'cms' ? ['Content', { name: 'Layout', color: '#f80' }] : ['Bug'] });
  try {
    assert.deepEqual((await s.call('/config')).labels, [{ name: 'Bug' }]);
    const cms = await (await fetch(s.base + '/config', { headers: { 'x-team': 'cms' } })).json();
    assert.deepEqual(cms.labels, [{ name: 'Content' }, { name: 'Layout', color: '#f80' }]);
  } finally { await s.close(); }
  const warn = console.warn; console.warn = () => {};
  const broken = await serve({ labels: () => { throw new Error('backend down'); } });
  try { assert.deepEqual((await broken.call('/config')).labels, []); }
  finally { console.warn = warn; await broken.close(); }
});

test('copy prompt (D47): the markdown store keeps its own; another store hides it unless given text', async () => {
  const cases: [RedlineOptions, unknown][] = [
    [{}, undefined],
    [{ prompt: 'Use the MCP tools ({open} open).' }, 'Use the MCP tools ({open} open).'],
    [{ prompt: false }, false],
    [{ prompt: '' }, false],
    [{ store: ({ root }) => createStore({ root, dir: 'feedback' }) }, undefined],
    [{ store: remoteStore({ url: 'http://127.0.0.1:9/' }) }, false],
    [{ store: remoteStore({ url: 'http://127.0.0.1:9/' }), prompt: 'Ask the team.' }, 'Ask the team.'],
  ];
  for (const [opts, want] of cases) {
    const s = await serve(opts);
    try { assert.deepEqual((await s.call('/config')).prompt, want, JSON.stringify(opts)); }
    finally { await s.close(); }
  }
});
