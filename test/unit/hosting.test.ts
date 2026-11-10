// Hosting the API elsewhere (D60): the Node `apiBase` option, the boot settings the self-starting
// overlay reads (window.redlineConfig, then the script's data-*), and servers.json for `redline mcp`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { apiBaseOf, createHandler, type RedlineOptions } from '../../src/server/handler.ts';
import { readBoot } from '../../src/client/boot.ts';
import { readServers } from '../../src/server/registry.ts';
import { pickBackend } from '../../src/mcp.ts';

async function serve(opts: RedlineOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-host-'));
  const { api, inject } = createHandler({ ...opts, root, serverRoot: root, clientFile: import.meta.filename });
  const server = http.createServer((req, res) => api(req, res, () => inject(req, res, () => {
    res.setHeader('content-type', 'text/html'); res.end('<html><body><p>app</p></body></html>');
  })));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { root, url, close: () => new Promise(r => server.close(r)) };
}

test('apiBaseOf: a path with a leading slash and no trailing one; the default when unset', () => {
  assert.equal(apiBaseOf(undefined), '/__redline');
  assert.equal(apiBaseOf(''), '/__redline');
  assert.equal(apiBaseOf('/x/__redline/'), '/x/__redline');
  assert.equal(apiBaseOf('tools/redline'), '/tools/redline');
});

test('readBoot: redlineConfig first, then data-*, then the default; trailing slashes dropped', () => {
  assert.deepEqual(readBoot(undefined, undefined), { apiBase: '/__redline' });
  assert.deepEqual(readBoot(undefined, { api: '/x/__redline/' }), { apiBase: '/x/__redline' });
  assert.deepEqual(readBoot({ apiBase: 'https://cms.example/__redline' }, { api: '/x' }), { apiBase: 'https://cms.example/__redline' });
  assert.deepEqual(readBoot({ apiBase: '  ' }, { api: '/x' }), { apiBase: '/x' });
  assert.deepEqual(readBoot('nonsense' as never, {}), { apiBase: '/__redline' });
});

test('apiBase: the API answers under it only, the tag carries data-api, extensions and servers.json follow', async () => {
  const s = await serve({ apiBase: '/x/__redline', extensions: ['ext.js'] });
  try {
    const html = await (await fetch(s.url + '/', { headers: { accept: 'text/html' } })).text();
    assert.match(html, /<script type="module" src="\/x\/__redline\/client\.js" data-api="\/x\/__redline" data-redline-client><\/script>/);
    const config = await (await fetch(s.url + '/x/__redline/config')).json();
    assert.deepEqual(config.extensions, ['/x/__redline/ext/0.js']);
    const notes = await fetch(s.url + '/x/__redline/notes');
    assert.equal(notes.status, 200);
    assert.equal((await fetch(s.url + '/x/__redline/notes', { headers: { 'if-none-match': notes.headers.get('etag')! } })).status, 304);
    assert.doesNotMatch(await (await fetch(s.url + '/__redline/config', { headers: { accept: 'text/html' } })).text(), /hotkey/);
    // `redline mcp` finds it under its base.
    await new Promise(r => setTimeout(r, 100));
    const [entry] = await readServers(s.root);
    assert.equal(entry.api, '/x/__redline');
    const backend = await pickBackend({ root: s.root });
    assert.match(backend.label, /^dev server /);
    assert.deepEqual(await backend.list(), []);
  } finally { await s.close(); }
});

test('without apiBase the tag is unchanged and servers.json has no api field', async () => {
  const s = await serve();
  try {
    const html = await (await fetch(s.url + '/', { headers: { accept: 'text/html' } })).text();
    assert.match(html, /<script type="module" src="\/__redline\/client\.js" data-redline-client><\/script>/);
    await fetch(s.url + '/__redline/config');
    await new Promise(r => setTimeout(r, 100));
    const [entry] = await readServers(s.root);
    assert.equal(entry.api, undefined);
  } finally { await s.close(); }
});

test('readBoot: credentials from redlineConfig or data-credentials (known values only); headers from redlineConfig only', () => {
  assert.equal(readBoot(undefined, { credentials: 'include' }).credentials, 'include');
  assert.equal(readBoot({ credentials: 'same-origin' }, { credentials: 'include' }).credentials, 'same-origin');
  assert.equal(readBoot(undefined, { credentials: 'sometimes' }).credentials, undefined);
  const headers = () => ({ authorization: 'Bearer x' });
  assert.equal(readBoot({ headers }, undefined).headers, headers);
  assert.equal(readBoot({ headers: 'nope' as never }, undefined).headers, undefined);
});

test('cors: preflights answered for listed origins only, credentials allowed, etag exposed; never on MCP', async () => {
  const s = await serve({ cors: ['http://app.test:3000/'] });
  try {
    const pre = await fetch(s.url + '/__redline/notes', { method: 'OPTIONS', headers: { origin: 'http://app.test:3000', 'access-control-request-method': 'PATCH' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://app.test:3000');
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, HEAD, POST, PATCH, DELETE');
    assert.equal(pre.headers.get('access-control-allow-headers'), 'x-redline, authorization, content-type, if-none-match');
    const get = await fetch(s.url + '/__redline/notes', { headers: { origin: 'http://app.test:3000' } });
    assert.equal(get.headers.get('access-control-expose-headers'), 'etag');
    assert.ok(get.headers.get('etag'));
    const other = await fetch(s.url + '/__redline/notes', { method: 'OPTIONS', headers: { origin: 'http://evil.test' } });
    assert.notEqual(other.status, 204);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const mcp = await fetch(s.url + '/__redline/mcp', { method: 'OPTIONS', headers: { origin: 'http://app.test:3000' } });
    assert.equal(mcp.headers.get('access-control-allow-origin'), null);
  } finally { await s.close(); }
});

test('without cors nothing changes: no CORS headers, a preflight is refused like any call without x-redline', async () => {
  const s = await serve();
  try {
    const pre = await fetch(s.url + '/__redline/notes', { method: 'OPTIONS', headers: { origin: 'http://app.test:3000' } });
    assert.equal(pre.status, 403);
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
  } finally { await s.close(); }
});
