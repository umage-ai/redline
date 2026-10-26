// @umage.ai/redline-hub (hub/, D44): the protocol per project through remoteStore, personal
// tokens and authors, allowed sites, the resolved-note window (D42), the change feed, MCP per
// project, the UI API's sessions and scopes, persistence, and the CLI's --host warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../hub/src/db.ts';
import { createHub } from '../../hub/src/server.ts';
import { cleanSites, siteAllowed } from '../../hub/src/store.ts';
import { hostWarning, parseArgs } from '../../hub/src/args.ts';
import { remoteStore } from '../../src/server/remote.ts';
import type { NewNoteRequest } from '../../src/shared/types.ts';

const PNG = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');

async function start(file = ':memory:') {
  const db = openDb(file);
  const key = db.adminKey()!;
  let clock = Date.parse('2026-10-20T10:00:00Z');
  const hub = createHub({ db, now: () => clock });
  const server = await hub.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const api = async (method: string, p: string, body?: unknown, as = cookie) => {
    const r = await fetch(url + '/api' + p, { method, headers: { 'x-redline-hub': '1', cookie: as, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const login = async (k: string) => (await api('POST', '/login', { key: k }, '')).cookie;
  cookie = await login(key);
  return {
    url, db, key, api, login,
    tick: (ms: number) => { clock += ms; },
    async project(name: string, sites?: string) { return (await api('POST', '/projects', { name, sites })).json; },
    async token(slug: string, person: string, kind = 'member') { return (await api('POST', `/projects/${slug}/tokens`, { person, kind })).json; },
    close: () => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => { db.close(); r(); })); },
  };
}

const note = (body: string, url = 'http://localhost:5173/settings'): NewNoteRequest => ({
  note: { type: 'comment', page: '/settings', url, body, target: { selector: '#save', tag: 'button', text: 'Save' } },
  screenshot: PNG,
});

test('protocol per project: the token names the author, mine is per caller, forged store fields are dropped', async () => {
  const h = await start();
  try {
    const p = await h.project('Customer portal');
    assert.equal(p.slug, 'customer-portal');
    assert.equal(p.store, `${h.url}/p/customer-portal`);
    const alice = remoteStore({ url: p.store, token: (await h.token(p.slug, 'alice@example.com')).token });
    const bob = remoteStore({ url: p.store, token: (await h.token(p.slug, 'bob@example.com')).token });

    const forged = note('Too tight') as NewNoteRequest & { note: Record<string, unknown> };
    Object.assign(forged.note, { author: 'mallory', resolvedAt: '2020-01-01T00:00:00Z', href: 'javascript:alert(1)', seen: true });
    const n = await alice.create(forged);
    assert.equal(n.author, 'alice@example.com');
    assert.equal(n.mine, true);
    assert.equal(n.resolvedAt, undefined);
    assert.equal(n.seen, undefined);
    assert.equal(n.href, `${h.url}/#/p/customer-portal/n/${n.id}`);
    assert.equal(n.screenshot, `${n.id}.png`);
    assert.deepEqual((await alice.asset(`${n.id}.png`))?.data, Buffer.from('fake-png'));

    const [seenByBob] = await bob.list();
    assert.equal(seenByBob.mine, false);
    assert.equal(seenByBob.body, 'Too tight');
    assert.match(await bob.version(), /^\d+\.1$/);
  } finally { await h.close(); }
});

test('tokens are scoped to their project: wrong, missing or another project\'s token is refused; unknown project is a 404', async () => {
  const h = await start();
  try {
    const a = await h.project('Alpha');
    const b = await h.project('Beta');
    const tokA = (await h.token(a.slug, 'alice@example.com')).token;
    await remoteStore({ url: a.store, token: tokA }).create(note('In alpha'));
    await assert.rejects(remoteStore({ url: b.store, token: tokA }).list(), /token for project "beta"/);
    await assert.rejects(remoteStore({ url: a.store }).list(), /token for project "alpha"/);
    await assert.rejects(remoteStore({ url: a.store, token: 'rht_nope' }).list(), /token/);
    await assert.rejects(remoteStore({ url: `${h.url}/p/gamma`, token: tokA }).list(), /no project "gamma"/);
    // A revoked token stops working at once.
    const t = (await h.api('GET', `/projects/${a.slug}/tokens`)).json.tokens[0];
    assert.equal((await h.api('DELETE', `/projects/${a.slug}/tokens/${t.id}`)).status, 200);
    await assert.rejects(remoteStore({ url: a.store, token: tokA }).list(), /token/);
    // Browser pages get nothing from the protocol, even with a token.
    const r = await fetch(`${a.store}/notes`, { headers: { authorization: `Bearer ${(await h.token(a.slug, 'x')).token}`, origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  } finally { await h.close(); }
});

test('allowed sites: a note filed from another site is refused with a sentence the reviewer can act on', async () => {
  assert.deepEqual(cleanSites('https://staging.example.com/, http://localhost:5173\nhttps://*.Preview.example.com'), ['https://staging.example.com', 'http://localhost:5173', 'https://*.preview.example.com']);
  assert.throws(() => cleanSites('ftp://x.example'), /only http and https/);
  assert.equal(siteAllowed([], 'https://anything.example'), true);
  assert.equal(siteAllowed(['https://*.preview.example.com'], 'https://pr-12.preview.example.com/x'), true);
  assert.equal(siteAllowed(['https://*.preview.example.com'], 'https://preview.example.com.evil.example/'), false);
  assert.equal(siteAllowed(['http://localhost:5173'], 'http://localhost:5174/'), false);

  const h = await start();
  try {
    const p = await h.project('Shop', 'https://staging.shop.example');
    const s = remoteStore({ url: p.store, token: (await h.token(p.slug, 'alice@example.com')).token });
    await assert.rejects(s.create(note('From prod', 'https://www.shop.example/cart')), /takes notes from https:\/\/staging\.shop\.example only, not https:\/\/www\.shop\.example/);
    assert.equal((await s.create(note('From staging', 'https://staging.shop.example/cart'))).body, 'From staging');
  } finally { await h.close(); }
});

test('resolved notes (D42): green with the reply, listed until a little after the author has seen them, or 24 h', async () => {
  const h = await start();
  try {
    const p = await h.project('Portal');
    const alice = remoteStore({ url: p.store, token: (await h.token(p.slug, 'alice@example.com')).token });
    const bob = remoteStore({ url: p.store, token: (await h.token(p.slug, 'bob@example.com')).token });
    const n = await alice.create(note('Make it primary'));
    const other = await alice.create(note('Never looked at'));

    // Resolved in the hub's UI.
    const v0 = await alice.version();
    const r = await h.api('PATCH', `/projects/${p.slug}/notes/${n.id}`, { done: true, reply: 'Done in Button.tsx' });
    assert.equal(r.json.done, true);
    assert.equal(r.json.resolvedAt, '2026-10-20T10:00:00.000Z');
    await h.api('PATCH', `/projects/${p.slug}/notes/${other.id}`, { done: true });
    assert.notEqual(await alice.version(), v0);
    const listed = (await alice.list()).find(x => x.id === n.id)!;
    assert.equal(listed.reply, 'Done in Button.tsx');
    assert.ok(listed.resolvedAt);

    // Only the author's "seen" counts... and it ages the note out after the grace window.
    await bob.update(n.id, { seen: true });
    assert.equal((await alice.list()).find(x => x.id === n.id)!.seen, undefined, 'seen from someone else is dropped');
    await alice.update(n.id, { seen: true });
    assert.equal((await alice.list()).find(x => x.id === n.id)!.seen, true);
    h.tick(4 * 60_000);
    assert.equal((await alice.list()).length, 2);
    const before = await alice.version();
    h.tick(2 * 60_000);
    assert.deepEqual((await alice.list()).map(x => x.id), [other.id]);
    assert.notEqual(await alice.version(), before, 'the version changes when a note ages out, so the overlay re-reads');

    // Never seen: gone after 24 h, but still in the hub's UI.
    h.tick(24 * 3_600_000);
    assert.deepEqual(await alice.list(), []);
    assert.equal((await h.api('GET', `/projects/${p.slug}/notes?status=resolved`)).json.notes.length, 2);

    // Reopened: open again, no resolvedAt, listed again.
    await h.api('PATCH', `/projects/${p.slug}/notes/${n.id}`, { done: false });
    const back = await alice.list();
    assert.deepEqual(back.map(x => [x.id, x.done, x.resolvedAt, x.seen]), [[n.id, false, undefined, undefined]]);

    // Archived: off the page and out of the open list.
    await h.api('PATCH', `/projects/${p.slug}/notes/${n.id}`, { archived: true });
    assert.deepEqual(await alice.list(), []);
    assert.equal((await h.api('GET', `/projects/${p.slug}/notes?status=archived`)).json.notes[0].id, n.id);
  } finally { await h.close(); }
});

test('change feed: dev servers hear about a note resolved in the hub at once', async () => {
  const h = await start();
  try {
    const p = await h.project('Live');
    const s = remoteStore({ url: p.store, token: (await h.token(p.slug, 'alice@example.com')).token });
    const n = await s.create(note('Hello'));
    let changes = 0;
    const stop = s.subscribe!(() => { changes++; });
    const until = async (c: () => boolean) => { const end = Date.now() + 3000; while (!c()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };
    await until(() => changes >= 1);   // connected
    const at = changes;
    await h.api('PATCH', `/projects/${p.slug}/notes/${n.id}`, { done: true });
    await until(() => changes > at);
    stop();
  } finally { await h.close(); }
});

test('MCP per project: the tools read and close that project\'s notes, with a project token; local or not', async () => {
  const h = await start();
  try {
    const p = await h.project('Agents');
    const alice = remoteStore({ url: p.store, token: (await h.token(p.slug, 'alice@example.com')).token });
    const n = await alice.create(note('Rename to Publish'));
    const agent = (await h.token(p.slug, 'Claude Code', 'agent')).token;
    const rpc = (body: unknown, token: string | null = agent, extra: Record<string, string> = {}) => fetch(p.mcp, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(body),
    });

    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status, 401);
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, agent, { origin: 'https://evil.example' })).status, 403);
    const other = await h.project('Other');
    assert.equal((await fetch(other.mcp, { method: 'POST', headers: { authorization: `Bearer ${agent}` }, body: '{}' })).status, 401);

    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    assert.equal(init.result.serverInfo.name, 'redline');
    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_notes', arguments: {} } })).json();
    assert.match(list.result.content[0].text, /1 open note from Redline hub, project Agents/);
    assert.match(list.result.content[0].text, /Rename to Publish/);
    const got = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_note', arguments: { id: n.id } } })).json();
    assert.equal(got.result.content[1].type, 'image');
    await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_note', arguments: { id: n.id, done: true, reply: 'Renamed (abc1234)' } } });

    const [resolved] = await alice.list();
    assert.equal(resolved.reply, 'Renamed (abc1234)');
    assert.ok(resolved.resolvedAt, 'an agent closing a note resolves it: the reviewer sees it green');
    // Agent tokens are for MCP, not the UI.
    assert.equal((await h.api('POST', '/login', { key: agent }, '')).status, 403);
  } finally { await h.close(); }
});

test('UI API: sessions, the CSRF header, admin-only parts, members see only their own project', async () => {
  const h = await start();
  try {
    const a = await h.project('Alpha');
    await h.project('Beta');
    assert.equal((await h.api('GET', '/projects', undefined, '')).status, 401);
    assert.equal((await h.api('POST', '/login', { key: 'rha_wrong' }, '')).status, 401);
    const r = await fetch(`${h.url}/api/projects`, { method: 'POST', headers: { cookie: (await h.login(h.key)), 'content-type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(r.status, 403, 'writes need x-redline-hub');
    assert.equal((await h.api('POST', '/projects', { name: 'Alpha' })).status, 409);
    assert.equal((await h.api('POST', '/projects', { name: 'Bad', slug: 'Bad Slug' })).status, 400);

    const member = await h.login((await h.token(a.slug, 'alice@example.com')).token);
    assert.ok(member);
    assert.deepEqual((await h.api('GET', '/projects', undefined, member)).json.projects.map((p: { slug: string }) => p.slug), ['alpha']);
    assert.equal((await h.api('GET', '/projects/beta/notes', undefined, member)).status, 404);
    assert.equal((await h.api('GET', `/projects/${a.slug}/tokens`, undefined, member)).status, 403);
    assert.equal((await h.api('POST', '/projects', { name: 'Mine' }, member)).status, 403);
    assert.equal((await h.api('GET', `/projects/${a.slug}/notes`, undefined, member)).status, 200);
    assert.deepEqual((await h.api('GET', '/me', undefined, member)).json.person, 'alice@example.com');

    // Logging out ends the session server-side.
    await h.api('POST', '/logout', {}, member);
    assert.equal((await h.api('GET', '/me', undefined, member)).status, 401);

    // Sketches are served so a script inside one can't run in the hub's origin.
    const s = remoteStore({ url: a.store, token: (await h.token(a.slug, 'bob@example.com')).token });
    const n = await s.create({ ...note('Sketch'), sketch: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
    const svg = await fetch(`${h.url}/api/projects/${a.slug}/assets/${n.id}.svg`, { headers: { cookie: await h.login(h.key) } });
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.match(svg.headers.get('content-security-policy') ?? '', /sandbox/);

    // The page itself runs under a nonce CSP.
    const page = await fetch(h.url + '/');
    const csp = page.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && (await page.text()).includes(`<script nonce="${nonce}">`));
  } finally { await h.close(); }
});

test('the database keeps projects, tokens and notes across restarts; reset-admin replaces the key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-hub-'));
  const file = path.join(dir, 'hub.db');
  let h = await start(file);
  const p = await h.project('Kept');
  const token = (await h.token(p.slug, 'alice@example.com')).token;
  await remoteStore({ url: p.store, token }).create(note('Survives'));
  const oldKey = h.key;
  await h.close();

  const db = openDb(file);
  assert.equal(db.adminKey(), null, 'no new key once one exists');
  const fresh = db.adminKey(true)!;
  assert.notEqual(fresh, oldKey);
  assert.equal(db.isAdminKey(oldKey), false);
  assert.equal(db.isAdminKey(fresh), true);
  db.close();

  h = await start(file);
  try {
    const p2 = (await h.api('POST', '/login', { key: fresh }, '')).cookie;
    assert.ok(p2);
    const store = remoteStore({ url: `${h.url}/p/kept`, token });
    assert.deepEqual((await store.list()).map(n => n.body), ['Survives']);
  } finally { await h.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('CLI: localhost by default; any other --host warns', () => {
  const o = parseArgs([]);
  assert.equal(o.host, '127.0.0.1');
  assert.equal(o.port, 4780);
  for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.2']) assert.equal(hostWarning(host), null, host);
  for (const host of ['0.0.0.0', '::', '192.168.1.20', 'hub.internal']) assert.match(hostWarning(host) ?? '', /anyone who can reach this machine/, host);
  assert.deepEqual(parseArgs(['--host', '0.0.0.0', '--port', '0', '--public-url', 'https://hub.example.com']), { cmd: 'serve', port: 0, host: '0.0.0.0', db: 'redline-hub.db', publicUrl: 'https://hub.example.com', help: false });
  assert.throws(() => parseArgs(['--public-url', 'hub.example.com']), /must start with http/);
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});
