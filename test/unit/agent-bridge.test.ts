// The agent bridge (agent-bridge/, D63): Redline-free (nothing imported from outside its folder), its
// guards built in (a host can narrow them, never widen them), and its CLI emitter speaking the same
// OSC 7501 the bridge reads. Sessions themselves: agent.test.ts and agent-acp.test.ts, through Redline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createBridge, TOKEN_HEADER } from '../../agent-bridge/src/handler.ts';
import { OscScanner } from '../../agent-bridge/src/program-status.ts';
import { programStatus, report7501 } from '../../agent-bridge/src/emit.ts';

const SRC = path.resolve('agent-bridge/src');
// What the bridge may import besides its own files: Node's built-ins and its own (optional) dependencies.
const ALLOWED = new Set(['@xterm/headless', 'node-pty', '@lydell/node-pty']);

test('agent bridge: no imports from outside its folder (Redline-free, D63)', async () => {
  const files = (await fs.readdir(SRC)).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 8, 'the bridge sources are there');
  const bad: string[] = [];
  for (const f of files) {
    // Code only: comments may show how a consumer imports the package.
    const text = (await fs.readFile(path.join(SRC, f), 'utf8')).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // import/export … from '…', import('…'), require('…') (string literals only; node-pty is required by name in a loop).
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm)) {
      const spec = m[2];
      if (spec.startsWith('.')) {
        const to = path.resolve(SRC, spec);
        if (path.relative(SRC, to).startsWith('..')) bad.push(`${f}: ${spec}`);
      } else if (!spec.startsWith('node:') && !builtinModules.includes(spec) && !ALLOWED.has(spec)) bad.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(bad, [], 'imports out of agent-bridge/src');
  const pkg = JSON.parse(await fs.readFile('agent-bridge/package.json', 'utf8'));
  assert.equal(pkg.private, true, 'unpublished for now: private, so npm publish refuses it');
  const wf = await fs.readFile('.github/workflows/publish.yml', 'utf8');
  assert.ok(!/working-directory:\s*agent-bridge/.test(wf), 'the publish workflow leaves agent-bridge alone');
});

test('agent bridge: this machine only and the token, whatever the host says; the host can only narrow it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-bridge-'));
  const bridge = createBridge({ root, command: process.execPath, info: () => ({ host: 'mine' }) });
  let allowed = true;
  const server = http.createServer((rq, rs) => bridge.handle(rq, rs, new URL(rq.url!, 'http://x').pathname, { allowed }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  // http.request, not fetch: fetch won't send another Host.
  const get = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; json(): Promise<any> }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host: `localhost:${port}`, ...headers } }, r => {
      let b = ''; r.on('data', d => { b += d; }); r.on('end', () => resolve({ status: r.statusCode!, json: async () => JSON.parse(b) }));
    }).on('error', reject);
  });
  try {
    const info = await (await get('/info')).json();
    assert.equal(info.host, 'mine', 'the host\'s fields are merged into /info');
    assert.equal(typeof info.token, 'string');
    assert.equal(info.token, bridge.token);
    // A DNS-rebound name resolving to 127.0.0.1 still names itself in Host: refused.
    assert.equal((await get('/info', { host: 'evil.example' })).status, 403, 'a foreign Host');
    assert.equal((await get('/info', { origin: 'http://evil.example' })).status, 403, 'a foreign Origin');
    const post = (p: string, headers: Record<string, string>) => fetch(`http://localhost:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"mode":"shared"}' });
    assert.equal((await post('/mode', {})).status, 403, 'no token');
    assert.equal((await post('/mode', { [TOKEN_HEADER]: info.token })).status, 200, 'the token');
    allowed = false;
    assert.equal((await get('/info')).status, 403, 'the host refused the caller');
  } finally { server.close(); bridge.group.dispose(); }
  // A caller from another machine, straight at the handler, the host saying yes: still refused.
  const out = { statusCode: 0, setHeader() {}, end() {} } as unknown as http.ServerResponse;
  await bridge.handle({ url: '/info', method: 'GET', headers: { host: 'localhost:1' }, socket: { remoteAddress: '192.168.1.9' } } as never, out, '/info', { allowed: true });
  assert.equal(out.statusCode, 403);
});

test('agent bridge emitter: reports the bridge reads back; values cleaned rather than dropped; detect() answers', async () => {
  const scan = (s: string) => new OscScanner().feed(s);
  const r = scan(report7501('working', { app: 'my-cli', msg: 'Reading\nfiles', progress: 40, id: 'a/b' }));
  assert.deepEqual(r, [{ type: 'report', report: { state: 'working', app: 'my-cli', msg: 'Reading files', progress: 40, id: 'a/b' } }]);
  assert.deepEqual(scan(report7501('blocked', { kind: 'permission', msg: 'Edit x?' }))[0], { type: 'report', report: { state: 'blocked', kind: 'permission', msg: 'Edit x?' } });
  // Bad values are left out, not sent (the bridge would drop the whole report).
  assert.deepEqual(scan(report7501('done', { app: 'has space', progress: 150, msg: 'é'.repeat(3000) }))[0], { type: 'report', report: { state: 'done', msg: 'é'.repeat(1024) } });
  const out = new PassThrough(), input = new PassThrough();
  const st = programStatus({ app: 'my-cli', out, input });
  const sent: string[] = [];
  out.on('data', d => sent.push(String(d)));
  const yes = st.detect(500);
  input.write('\x1b]7501;?\x1b\\\x1b[?1;2c');   // the bridge's answers, in order (D53)
  assert.equal(await yes, true);
  assert.deepEqual(scan(sent.join('')).map(e => e.type), ['probe', 'da1']);
  const no = st.detect(500);
  input.write('\x1b[?1;2c');
  assert.equal(await no, false, 'only the DA1 answer: no 7501');
  st.done('Changed 3 files');
  assert.deepEqual(scan(sent.at(-1)!)[0], { type: 'report', report: { state: 'done', app: 'my-cli', msg: 'Changed 3 files' } });
});
