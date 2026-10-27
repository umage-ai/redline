// Next.js (D48): withRedline's config in `next dev` only, the API server behind the rewrite, and the
// loader that stamps JSX for webpack and Turbopack. The browser side is in test/e2e (fixtures next, next-turbo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { networkHost, withRedline, type NextConfig, type NextConfigFn } from '../../src/next.ts';
import redlineLoader from '../../src/next-loader.ts';

const DEV = 'phase-development-server';
const ctx = { defaultConfig: {} };
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-next-'));
const dev = (config: NextConfig | NextConfigFn, opts = {}) => withRedline<NextConfig>(config, { root, ...opts })(DEV, ctx);
const warn = console.warn, log = console.log;

test('next build and next start get the config back untouched, object or function', async () => {
  const config = { reactStrictMode: true, rewrites: async () => [] };
  assert.equal(await withRedline(config)('phase-production-build', ctx), config);
  assert.equal(await withRedline(config)('phase-production-server', ctx), config);
  assert.equal(await withRedline((phase: string) => ({ ...config, phase }))('phase-production-build', ctx).then((c: NextConfig) => c.phase), 'phase-production-build');
});

test('withRedline keeps the app\'s config type, so Next\'s NextConfig still checks it', () => {
  type Cfg = { reactStrictMode?: boolean; images?: { unoptimized?: boolean } };
  const cfg: Cfg = { reactStrictMode: true };
  const wrapped: (phase: string, ctx: { defaultConfig: Cfg }) => Promise<Cfg> = withRedline(cfg);   // Next's own shape for a config function
  // @ts-expect-error a typo in the config is a type error (only `npm run typecheck` sees this line)
  withRedline<Cfg>({ reactStrictMod: true });
  assert.equal(typeof wrapped, 'function');
});

test('next dev: /__redline/* is rewritten first, past basePath, to the API server; the app\'s rewrites stay', async () => {
  console.log = () => {};
  try {
    const app = { source: '/old', destination: '/new' };
    const listed = await (await dev({ basePath: '/docs', rewrites: async () => [app] })).rewrites();
    assert.equal(listed.beforeFiles.length, 1);
    assert.deepEqual(listed.afterFiles, [app]);
    const ours = listed.beforeFiles[0];
    assert.equal(ours.source, '/__redline/:path*');
    assert.equal(ours.basePath, false);
    assert.match(ours.destination, /^http:\/\/127\.0\.0\.1:\d+\/__redline\/:path\*$/);

    const grouped = await (await dev(async () => ({ rewrites: async () => ({ beforeFiles: [app], fallback: [app] }) }))).rewrites();
    assert.deepEqual(grouped.beforeFiles, [ours, app]);
    assert.deepEqual(grouped.fallback, [app]);

    // One API server per process: Next reads its config more than once.
    assert.equal((await (await dev({})).rewrites()).beforeFiles[0].destination, ours.destination);
    const config = await (await fetch(ours.destination.replace(':path*', 'config'))).json();
    assert.equal(config.dir, '.redline');
  } finally { console.log = log; }
});

test('next dev: the loader runs before SWC under webpack and on .tsx/.jsx under Turbopack', async () => {
  const seen: unknown[] = [];
  const out = await dev({ webpack: (c: NextConfig, w: unknown) => { seen.push(w); return c; }, turbopack: { root, rules: { '*.svg': { loaders: ['svgr'] } } } });
  const cfg = out.webpack({ module: { rules: [{ test: /x/ }] } }, { dev: true });
  assert.deepEqual(seen, [{ dev: true }]);   // the app's own webpack() still runs
  const rule = cfg.module.rules[0];
  assert.equal(rule.enforce, 'pre');
  assert.ok(rule.test.test('a.tsx') && rule.test.test('a.jsx') && !rule.test.test('a.ts'));
  assert.ok(rule.exclude.test('/app/node_modules/x/a.jsx'));
  assert.match(rule.use[0].loader, /next-loader\.cjs$/);
  assert.equal(rule.use[0].options.root, root);
  assert.equal(out.turbopack.root, root);
  assert.deepEqual(out.turbopack.rules['*.svg'], { loaders: ['svgr'] });
  assert.deepEqual(out.turbopack.rules['*.tsx'], { loaders: [rule.use[0]] });
  assert.deepEqual(out.turbopack.rules['*.jsx'], { loaders: [rule.use[0]] });

  // The app's own *.tsx rule wins (with a warning); jsxSource: false adds no loader.
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    const mine = { loaders: ['mine'] };
    assert.equal((await dev({ turbopack: { rules: { '*.tsx': mine } } })).turbopack.rules['*.tsx'], mine);
    assert.match(warned[0], /turbopack\.rules\['\*\.tsx'\]/);
  } finally { console.warn = warn; }
  const off = await dev({}, { jsxSource: false });
  assert.equal(off.webpack, undefined);
  assert.equal(off.turbopack, undefined);
});

test('next dev: MCP through a proxy that didn\'t stamp the caller is refused without tokens; called directly, it answers', async () => {
  const { destination } = (await (await dev({})).rewrites()).beforeFiles[0];
  const mcp = destination.replace(':path*', 'mcp');
  const call = (headers: Record<string, string> = {}) => fetch(mcp, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
  });
  const proxied = await call({ 'x-forwarded-host': 'localhost:3000' });
  assert.equal(proxied.status, 401);
  assert.match((await proxied.json()).error, /redline mcp/);
  const direct = await call();
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).result.serverInfo.name, 'redline');
});

test('networkHost: next dev listens on the network unless -H is loopback (a warning when network is on)', () => {
  const cli = (...a: string[]) => networkHost(['node', 'next', 'dev', ...a], {});
  assert.equal(cli(), 'every network interface');
  assert.equal(cli('-H', '0.0.0.0'), 'every network interface');
  assert.equal(cli('--hostname=192.168.1.20'), '192.168.1.20');
  for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(cli('-H', h), null, h);
  assert.equal(cli('--hostname=localhost'), null);
  assert.equal(networkHost(['node', 'start-server.js'], { NEXT_PRIVATE_WORKER: '1' }), null);   // the worker can't see the flag
  assert.equal(networkHost(['node', '--test', 'next.test.ts'], {}), null);                    // not next dev
});

// Next's rewrite as far as it matters here: the caller's headers on, its Host as x-forwarded-host, from 127.0.0.1.
async function nextLikeProxy(destination: string) {
  const front = http.createServer((req, res) => {
    const target = new URL(destination.replace(':path*', (req.url ?? '').slice('/__redline/'.length)));
    const out = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host, 'x-forwarded-host': req.headers.host ?? '' } }, r => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(out);
  });
  await new Promise<void>(r => front.listen(0, '0.0.0.0', r));
  const port = (front.address() as { port: number }).port;
  const call = (address: string, p: string, headers: Record<string, string>, body?: string) => new Promise<number>((resolve, reject) => {
    const rq = http.request({ host: address, port, path: p, method: body ? 'POST' : 'GET', headers }, rs => { rs.resume(); resolve(rs.statusCode ?? 0); });
    rq.on('error', reject);
    rq.end(body);
  });
  return { port, call, close: () => front.close() };
}

test('next dev: through the rewrite the API server knows the caller\'s real address, so another machine can\'t fake its Host (D48)', async () => {
  const { destination } = (await (await dev({})).rewrites()).beforeFiles[0];
  const front = await nextLikeProxy(destination);
  try {
    const local = `localhost:${front.port}`;
    assert.equal(await front.call('127.0.0.1', '/__redline/config', { host: local }), 200);
    assert.equal(await front.call('127.0.0.1', '/__redline/config', { host: `192.168.1.20:${front.port}` }), 403);   // the Host check stays
    const mcp = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    const json = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    assert.equal(await front.call('127.0.0.1', '/__redline/mcp', { host: local, ...json }, mcp), 200);   // stamped: MCP knows it's local

    // From this machine's own network address the socket shows that address, whatever the Host says.
    const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!lan) return void console.log('# no network interface: the LAN half of this test was skipped');
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await front.call(lan, '/__redline/config', { host: local }), 403);
      assert.equal(await front.call(lan, '/__redline/config', { host: local, 'x-redline-peer': 'guess 127.0.0.1' }), 403);
      assert.equal(await front.call(lan, '/__redline/mcp', { host: local, ...json }, mcp), 401);
    } finally { console.warn = warn; }
  } finally { front.close(); }
});

test('loader: stamps .tsx outside node_modules, with an object source map; leaves the rest as it came', () => {
  const run = (resourcePath: string, code: string, map?: unknown) => {
    let got: unknown[] = [];
    redlineLoader.call({ resourcePath, getOptions: () => ({ root }), callback: (...a: unknown[]) => { got = a; } }, code, map);
    return got as [null, string, unknown];
  };
  const [err, code, map] = run(path.join(root, 'app/page.tsx'), 'export default function Page() {\n  return <main>Hi</main>;\n}\n');
  assert.equal(err, null);
  assert.match(code, /<main data-redline-src="app\/page\.tsx:2:10 Page">/);
  assert.equal(typeof map, 'object');
  assert.equal((map as { version: number }).version, 3);

  const lib = 'export const A = () => <div />;';
  assert.deepEqual(run(path.join(root, 'node_modules/lib/a.jsx'), lib, 'in'), [null, lib, 'in']);
  assert.deepEqual(run(path.join(root, 'a.tsx'), 'export const n = 1;', 'in'), [null, 'export const n = 1;', 'in']);
});
