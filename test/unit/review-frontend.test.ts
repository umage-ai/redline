// examples/review-frontend (setup 3, D45): the gateway only routes a signed-in reviewer with the
// cookie and a live flag, strips a forged header and fails to the normal frontend; the cookie rule;
// and the example store acts as the reviewer, with the API's own words on refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chooseFrontend, REVIEW_HEADER, type GatewayRequest } from '../../examples/review-frontend/gateway.ts';
import { cookieAction } from '../../examples/review-frontend/switch.ts';
import { reviewStore } from '../../examples/review-frontend/store.ts';

const req = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({ headers: {}, cookies: {}, ...over });

test('gateway: review frontend only for a signed-in user with the cookie and a live flag', async () => {
  const flags = new Set(['review:enabled:u1']);
  const has = async (k: string) => flags.has(k);
  let lookups = 0;
  const counted = async (k: string) => { lookups++; return has(k); };

  const forged = req({ headers: { [REVIEW_HEADER]: 'on' } });
  assert.equal(await chooseFrontend(forged, counted), 'normal');
  assert.equal(forged.headers[REVIEW_HEADER], undefined, 'a client-sent header is stripped');
  assert.equal(lookups, 0, 'no cookie, no lookup');

  assert.equal(await chooseFrontend(req({ cookies: { 'review-mode': 'on' } }), counted), 'normal', 'anonymous');
  assert.equal(await chooseFrontend(req({ cookies: { 'review-mode': 'on' }, userId: 'u2' }), counted), 'normal', 'no flag');
  const ok = req({ cookies: { 'review-mode': 'on' }, userId: 'u1' });
  assert.equal(await chooseFrontend(ok, counted), 'review');
  assert.equal(ok.headers[REVIEW_HEADER], 'on');
  const logged: string[] = [];
  assert.equal(await chooseFrontend(req({ cookies: { 'review-mode': 'on' }, userId: 'u1' }), async () => { throw new Error('redis down'); }, m => logged.push(m)), 'normal', 'a failed lookup serves the app');
  assert.equal(logged.length, 1);
});

test('switch: the cookie follows the user; an anonymous request keeps what it has', () => {
  const reviewer = { id: 'u1', mayReview: true, reviewOn: true };
  assert.equal(cookieAction(reviewer, false), 'set');
  assert.equal(cookieAction(reviewer, true), null);
  assert.equal(cookieAction({ ...reviewer, reviewOn: false }, true), 'delete');
  assert.equal(cookieAction({ ...reviewer, mayReview: false }, true), 'delete', 'lost the right to review');
  assert.equal(cookieAction(null, true), null);
});

test('store: every call carries the reviewer\'s cookie; refusals reach the reviewer in the API\'s words; no request, no call', async () => {
  const cookies: string[] = [];
  const api = http.createServer((rq, rs) => {
    cookies.push(rq.headers.cookie ?? '');
    rs.setHeader('content-type', 'application/json');
    if (!rq.headers.cookie?.includes('session=')) { rs.statusCode = 401; return rs.end('{}'); }
    if (rq.url === '/notes' && rq.method === 'GET') return rs.end(JSON.stringify({ notes: [{ id: 'abcd1', type: 'comment', page: '/', url: 'http://x/', at: '', body: 'Hi', reply: '', done: false, author: 'qa@example.com' }] }));
    if (rq.url === '/notes' && rq.method === 'POST') { rs.statusCode = 403; return rs.end(JSON.stringify({ error: 'Review is switched off for this organization.' })); }
    if (rq.url?.startsWith('/notes/')) { rs.statusCode = 404; return rs.end('{}'); }
    rs.end(JSON.stringify({ version: '7' }));
  });
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
  const store = reviewStore({ api: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, noteUrl: id => `https://app.example/admin/review-notes?note=${id}` });
  const ctx = (cookie?: string) => ({ req: { headers: cookie ? { cookie } : {} } as http.IncomingMessage });
  try {
    assert.equal(await store.version(ctx('session=qa')), '7');
    const [n] = await store.list(ctx('session=qa'));
    assert.equal(n.author, 'qa@example.com');
    assert.equal(n.href, 'https://app.example/admin/review-notes?note=abcd1');
    await assert.rejects(store.create({ note: { type: 'comment', page: '/', url: 'http://x/', body: 'x' } }, ctx('session=qa')), /switched off for this organization/);
    assert.equal(await store.update('zzzz1', { done: true }, ctx('session=qa')), null);
    assert.equal(await store.remove('zzzz1', ctx('session=qa')), false);
    await assert.rejects(store.list(ctx()), /session has ended/);
    const before = cookies.length;
    await assert.rejects(store.list(), /no request to act for/);
    assert.equal(cookies.length, before, 'without a request the store never calls as the server');
    assert.ok(cookies.slice(0, 5).every(c => c === 'session=qa'));
  } finally { await new Promise(r => api.close(r)); }
});

test('same server (option B): only reviewers get the overlay script and /__redline; a failing check counts as no', async () => {
  const { reviewersOnly } = await import('../../examples/review-frontend/same-server.ts');
  const { createHandler } = await import('../../src/server/handler.ts');
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-review-'));
  await fs.mkdir(path.join(root, '.git'));
  const { api, inject } = createHandler({ serverRoot: root, root, clientFile: import.meta.filename });
  const isReviewer = (rq: http.IncomingMessage) => {
    if (rq.headers.cookie === 'session=broken') throw new Error('session store down');
    return rq.headers.cookie === 'session=qa';
  };
  const gatedApi = reviewersOnly(api, isReviewer), gatedInject = reviewersOnly(inject, isReviewer);
  const app = (rq: http.IncomingMessage, rs: http.ServerResponse) => {
    if (rq.url?.startsWith('/__redline')) { rs.statusCode = 404; return rs.end('app 404'); }
    rs.setHeader('content-type', 'text/html'); rs.end('<html><head></head><body>Shop</body></html>');
  };
  const srv = http.createServer((rq, rs) => gatedApi(rq, rs, () => gatedInject(rq, rs, () => app(rq, rs))));
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = (p: string, cookie?: string) => fetch(url + p, { headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } });
  try {
    assert.match(await (await get('/', 'session=qa')).text(), /data-redline-client/);
    assert.equal((await get('/__redline/config', 'session=qa')).status, 200);
    for (const who of [undefined, 'session=customer', 'session=broken']) {
      assert.doesNotMatch(await (await get('/', who)).text(), /redline/i, String(who));
      assert.equal((await get('/__redline/config', who)).status, 404, String(who));
    }
  } finally { await new Promise(r => srv.close(r)); await fs.rm(root, { recursive: true, force: true }); }
});
