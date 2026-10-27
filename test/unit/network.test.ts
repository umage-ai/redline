// The overlay's API has no login, so the dev-server plugins answer this machine only unless
// `network: true` (L46): a loopback address and a local Host. Behind Next's rewrite every call is
// from 127.0.0.1 and only the forwarded Host tells another machine's browser apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHandler, localCall, networkAllows } from '../../src/server/handler.ts';
import { redlineMiddleware } from '../../src/server/index.ts';

const req = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as never;

test('localCall: a loopback address and a local Host, forwarded or not', () => {
  for (const host of ['localhost:5173', '127.0.0.1:3000', '[::1]:3000', 'app.localhost:3000', 'localhost'])
    assert.equal(localCall(req('127.0.0.1', { host })), true, host);
  assert.equal(localCall(req('::1', { host: 'localhost:5173' })), true);
  assert.equal(localCall(req('::ffff:127.0.0.1', { host: 'localhost:5173' })), true);
  assert.equal(localCall(req('192.168.1.7', { host: 'localhost:5173' })), false);                             // another machine
  assert.equal(localCall(req('127.0.0.1', { host: '192.168.1.20:3000' })), false);                         // a LAN address in the Host
  assert.equal(localCall(req('127.0.0.1', { host: 'evil.example:5173' })), false);                         // DNS rebinding
  assert.equal(localCall(req('127.0.0.1', { host: '127.0.0.1:40001', 'x-forwarded-host': '192.168.1.20:3000' })), false);   // through Next
  assert.equal(localCall(req('127.0.0.1', { host: '127.0.0.1:40001', 'x-forwarded-host': 'localhost:3000' })), true);
  assert.equal(localCall(req('127.0.0.1', {})), false);
});

async function serve(opts: { network?: boolean | string[] }, middleware = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-net-'));
  const base = { root, serverRoot: root, clientFile: import.meta.filename, ...opts };
  const { api, inject } = middleware ? redlineMiddleware(base) : createHandler(base);
  const server = http.createServer((rq, rs) => api(rq, rs, () => inject(rq, rs, () => { rs.setHeader('content-type', 'text/html'); rs.end('<html><body>app</body></html>'); })));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (p: string, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { accept: 'text/html', ...headers } }, rs => {
      let body = ''; rs.on('data', c => body += c); rs.on('end', () => resolve({ status: rs.statusCode ?? 0, body }));
    }).on('error', reject);
  });
  return { get, close: () => server.close() };
}

test('plugins: another machine (as the Host shows) gets a 403 and a page without the overlay; network: true lets it in', async () => {
  const warn = console.warn, warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  const local = await serve({});
  const open = await serve({ network: true });
  try {
    assert.equal((await local.get('/__redline/config', { host: 'localhost:3000' })).status, 200);
    const lan = { host: '127.0.0.1:40001', 'x-forwarded-host': '192.168.1.20:3000' };
    const refused = await local.get('/__redline/config', lan);
    assert.equal(refused.status, 403);
    assert.match(refused.body, /network/);
    assert.equal((await local.get('/__redline/notes', { host: '192.168.1.20:3000' })).status, 403);
    assert.doesNotMatch((await local.get('/', lan)).body, /__redline\/client\.js/);
    assert.match((await local.get('/', { host: 'localhost:3000' })).body, /__redline\/client\.js/);
    assert.equal(warned.length, 1);   // said once, not per request
    assert.match(warned[0], /network: true/);
    assert.equal((await open.get('/__redline/config', lan)).status, 200);
  } finally { console.warn = warn; local.close(); open.close(); }
});

test('redlineMiddleware stays open by default: a deployed review server gates reviewers itself', async () => {
  const s = await serve({}, true);
  try { assert.equal((await s.get('/__redline/config', { host: 'review.example.com' })).status, 200); }
  finally { s.close(); }
});

test('network list: addresses and subnets admit those callers, host names a call from this machine with that Host', () => {
  const allows = networkAllows(['192.168.1.20', '172.16.0.0/12', 'fd00::/8', 'myapp.test', '*.dev.example']);
  assert.equal(allows(req('192.168.1.20', { host: '192.168.1.5:5173' })), true);          // a phone on the LAN
  assert.equal(allows(req('192.168.1.21', { host: '192.168.1.5:5173' })), false);
  assert.equal(allows(req('::ffff:172.17.0.1', { host: 'localhost:5173' })), true);       // Docker's gateway, as Node reports IPv4 on a dual-stack socket
  assert.equal(allows(req('fd00::5', { host: 'x' })), true);
  assert.equal(allows(req('127.0.0.1', { host: 'myapp.test' })), true);                   // nginx on this machine with its own domain
  assert.equal(allows(req('127.0.0.1', { host: 'web.dev.example:8443' })), true);
  assert.equal(allows(req('127.0.0.1', { host: 'myapp.test.evil.example' })), false);
  assert.equal(allows(req('192.168.1.99', { host: 'myapp.test' })), false);              // a host name never admits another machine
  assert.throws(() => networkAllows(['10.0.0.0/40']), /not an address, a subnet/);
  assert.throws(() => networkAllows(['http://myapp.test']), /not an address, a subnet/);
});

test('network list in the handler: listed callers get the API, others the 403 that names what to add', async () => {
  const warn = console.warn, warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  const s = await serve({ network: ['myapp.test'] });
  try {
    assert.equal((await s.get('/__redline/config', { host: 'myapp.test' })).status, 200);
    assert.equal((await s.get('/__redline/config', { host: 'other.test' })).status, 403);
    assert.match(warned[0], /add 'other\.test' to the network option/);
  } finally { console.warn = warn; s.close(); }
});
