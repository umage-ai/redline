// The remote store protocol (docs/PROTOCOL.md, D40-D42): remoteStore against the reference
// server notesProtocol, the dev server's handler in front of a remote store, the change feed,
// and the fields only a store may set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHandler, type Middleware, type RedlineOptions } from '../../src/server/handler.ts';
import { createStore, newId, stamp, type NoteStore } from '../../src/server/store.ts';
import { notesProtocol } from '../../src/server/protocol.ts';
import { remoteStore } from '../../src/server/remote.ts';
import { parsePage, serializePage } from '../../src/server/format.ts';
import type { Note } from '../../src/shared/types.ts';

const PNG = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');

async function tmpRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-remote-'));
  await fs.mkdir(path.join(root, '.git'));
  return root;
}

async function listen(mw: Middleware) {
  const server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  // SSE responses stay open; end them so close() returns.
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}

const TOKENS: Record<string, string> = { 'tok-alice': 'alice@example.com', 'tok-bob': 'bob@example.com' };
const authorize = (req: http.IncomingMessage) => TOKENS[/^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''] ?? null;

/** An in-memory store with a change feed, like a hosted store would have. */
function liveStore(): NoteStore & { notes: Note[] } {
  const notes: Note[] = [];
  const subs = new Set<() => void>();
  let v = 0;
  const changed = () => { v++; for (const s of subs) s(); };
  return {
    notes, dir: 'memory',
    async version() { return String(v); },
    async list() { return notes; },
    async create(req) { const n: Note = { ...req.note, id: newId(), at: stamp(), body: req.note.body ?? '', reply: '', done: false }; notes.push(n); changed(); return n; },
    async update(id, patch) { const n = notes.find(x => x.id === id); if (!n) return null; Object.assign(n, patch); changed(); return n; },
    async remove(id) { const i = notes.findIndex(x => x.id === id); if (i < 0) return false; notes.splice(i, 1); changed(); return true; },
    async asset() { return null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); }
};

test('round trip: the server sets the author from the token, forged store fields are dropped, mine is per caller', async () => {
  const root = await tmpRepo();
  const srv = await listen(notesProtocol(createStore({ root }), { base: '/redline', authorize }));
  try {
    const alice = remoteStore({ url: `${srv.url}/redline/`, token: 'tok-alice' });
    const bob = remoteStore({ url: `${srv.url}/redline`, token: 'tok-bob' });
    assert.equal(alice.dir, new URL(srv.url).host);

    const v0 = await alice.version();
    const n = await alice.create({
      note: { type: 'comment', page: '/settings', url: 'http://app/settings', body: 'Too tight', author: 'mallory', resolvedAt: '2020-01-01T00:00:00Z', href: 'javascript:alert(1)' } as Note,
      screenshot: PNG,
    });
    assert.equal(n.author, 'alice@example.com');
    assert.equal(n.mine, true);
    assert.equal(n.resolvedAt, undefined);
    assert.equal(n.href, undefined);
    assert.notEqual(await alice.version(), v0);

    assert.deepEqual((await alice.list()).map(x => [x.body, x.mine]), [['Too tight', true]]);
    assert.deepEqual((await bob.list()).map(x => [x.body, x.mine, x.author]), [['Too tight', false, 'alice@example.com']]);
    assert.equal((await bob.list())[0].file, undefined, 'local file paths are not sent to callers');

    const shot = await bob.asset(`${n.id}.png`);
    assert.equal(shot?.type, 'image/png');
    assert.equal(Buffer.from(shot!.data).toString(), 'fake-png');
    assert.equal(await bob.asset('../../etc/passwd'), null);

    const done = await bob.update(n.id, { done: true, reply: 'Fixed in abc123', seen: true });
    assert.equal(done?.done, true);
    assert.equal(done?.mine, false);
    assert.equal(await bob.update('nosuchnote', { done: true }), null);
    assert.equal(await alice.remove(n.id), true);
    assert.equal(await alice.remove(n.id), false);
  } finally { await srv.close(); }
});

test('refusals and store errors reach the reviewer in the store\'s own words', async () => {
  const root = await tmpRepo();
  const store = createStore({ root });
  const refusing: NoteStore = { ...store, async create() { throw new Error('Review notes are switched off for this project'); } };
  const srv = await listen(notesProtocol(refusing, { authorize }));
  try {
    await assert.rejects(remoteStore({ url: srv.url, token: 'wrong' }).list(), /a valid bearer token is required/);
    await assert.rejects(remoteStore({ url: srv.url }).list(), /a valid bearer token is required/);
    await assert.rejects(remoteStore({ url: srv.url, token: 'tok-bob' }).create({ note: { type: 'comment', page: '/', url: 'http://app/', body: 'x' } as Note }), /switched off for this project/);
    assert.throws(() => remoteStore({ url: 'file:///etc' }), /must be http/);
  } finally { await srv.close(); }
});

test('change feed: a subscriber hears about every change, from another caller too, until it unsubscribes', async () => {
  const store = liveStore();
  const srv = await listen(notesProtocol(store, { authorize }));
  try {
    const alice = remoteStore({ url: srv.url, token: 'tok-alice' });
    const bob = remoteStore({ url: srv.url, token: 'tok-bob' });
    let heard = 0;
    const stop = bob.subscribe!(() => { heard++; });
    await until(() => heard >= 1);   // connected: one catch-up
    await alice.create({ note: { type: 'comment', page: '/', url: 'http://app/', body: 'Live' } as Note });
    await until(() => heard >= 2);
    stop();
    const after = heard;
    await alice.create({ note: { type: 'comment', page: '/', url: 'http://app/', body: 'Unheard' } as Note });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(heard, after);
  } finally { await srv.close(); }
});

test('change feed: a store without one answers 404 and the subscriber gives up quietly', async () => {
  const srv = await listen(notesProtocol(createStore({ root: await tmpRepo() }), { authorize }));
  try {
    let heard = 0;
    const stop = remoteStore({ url: srv.url, token: 'tok-alice' }).subscribe!(() => { heard++; });
    await new Promise(r => setTimeout(r, 200));
    stop();
    assert.equal(heard, 0);
  } finally { await srv.close(); }
});

async function devServer(opts: RedlineOptions) {
  const root = await tmpRepo();
  const { api } = createHandler({ ...opts, serverRoot: root, clientFile: import.meta.filename });
  const srv = await listen(api);
  const base = `${srv.url}/__redline`;
  const call = async (p: string, init?: RequestInit) => (await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', 'x-redline': '1' } })).json();
  return { root, base, call, close: srv.close };
}

test('dev server: a page cannot set store fields; build is recorded; a patch keeps only the fields it may carry', async () => {
  const store = liveStore();
  const dev = await devServer({ store, build: 'abc1234' });
  try {
    assert.equal((await dev.call('/config')).events, true);
    const n = await dev.call('/notes', { method: 'POST', body: JSON.stringify({ note: { type: 'comment', page: '/', url: 'http://app/', body: 'Hi', author: 'mallory', mine: true, seen: true, resolvedAt: 'x', href: 'https://evil.example/' } }) });
    assert.equal(n.build, 'abc1234');
    for (const k of ['author', 'mine', 'seen', 'resolvedAt', 'href']) assert.equal(n[k], undefined, k);
    await dev.call(`/notes/${n.id}`, { method: 'PATCH', body: JSON.stringify({ seen: true, author: 'mallory', done: 'yes', body: 'Edited' }) });
    assert.equal(store.notes[0].seen, true);
    assert.equal(store.notes[0].author, undefined);
    assert.equal(store.notes[0].done, false, 'a non-boolean done is ignored');
    assert.equal(store.notes[0].body, 'Edited');
  } finally { await dev.close(); }
});

test('dev server: /events pushes a change to every open overlay; without a feed it is 404 and /config says so', async () => {
  const store = liveStore();
  const dev = await devServer({ store });
  try {
    const ctrl = new AbortController();
    const r = await fetch(`${dev.base}/events`, { signal: ctrl.signal });
    assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = r.body!.getReader();
    let text = '';
    const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += new TextDecoder().decode(value); } })().catch(() => {});
    await dev.call('/notes', { method: 'POST', body: JSON.stringify({ note: { type: 'comment', page: '/', url: 'http://app/', body: 'Live' } }) });
    await until(() => text.includes('event: change'));
    ctrl.abort();
    await reading;
  } finally { await dev.close(); }

  const plain = await devServer({});
  try {
    assert.equal((await plain.call('/config')).events, false);
    assert.equal((await fetch(`${plain.base}/events`)).status, 404);
  } finally { await plain.close(); }
});

test('dev server: REDLINE_STORE_URL picks a remote store without config, and notes go there', async () => {
  const backend = liveStore();
  const srv = await listen(notesProtocol(backend, { authorize }));
  process.env.REDLINE_STORE_URL = srv.url;
  process.env.REDLINE_STORE_TOKEN = 'tok-bob';
  try {
    const dev = await devServer({});
    try {
      assert.equal((await dev.call('/config')).dir, new URL(srv.url).host);
      await dev.call('/notes', { method: 'POST', body: JSON.stringify({ note: { type: 'comment', page: '/', url: 'http://app/', body: 'Remote' } }) });
      assert.equal(backend.notes[0].author, 'bob@example.com');
      // Only the dev server's own address book (servers.json, D22) is local; no note pages.
      await assert.rejects(fs.access(path.join(dev.root, '.redline', 'pages')), 'no notes are written locally');
    } finally { await dev.close(); }
  } finally {
    delete process.env.REDLINE_STORE_URL;
    delete process.env.REDLINE_STORE_TOKEN;
    await srv.close();
  }
});

test('markdown never holds what a remote store reports (resolved, seen, mine, link); author and build stay', () => {
  const note = { id: 'abcd1234', type: 'comment', page: '/', url: 'http://app/', at: '2026-10-16 10:00', body: 'x', reply: '', done: true,
    author: 'alice@example.com', build: 'abc1234', resolvedAt: '2026-10-16T10:00:00Z', mine: true, seen: true, href: 'https://store/n/1' } as Note;
  const md = serializePage('/', 'http://app/', [note]);
  for (const k of ['resolvedAt', 'mine', 'seen', 'href']) assert.ok(!md.includes(`"${k}"`), k);
  const [back] = parsePage(md);
  assert.equal(back.author, 'alice@example.com');
  assert.equal(back.build, 'abc1234');
});
