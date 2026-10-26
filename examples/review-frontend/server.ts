// The review frontend's server (setup 3, docs/SETUPS.md): the same app build, with Redline's
// middleware in front of it. Only the review image runs this; the normal image starts your
// framework's server as usual and contains no Redline code.
//
//   /__redline/*    → Redline's API, over a store that acts as the signed-in reviewer
//   HTML responses  → the overlay's <script> added
//   everything else → your app's handler, untouched
//
// Shown for a Node app whose framework exports a connect-style handler (SvelteKit's adapter-node
// `build/handler.js`, Express, Fastify's `.routing`); APP_HANDLER points at it.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redlineMiddleware, remoteStore } from '@umage.ai/redline/server';
import { reviewStore } from './store.ts';

type Next = (err?: unknown) => void;
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, next: Next) => void;

const env = (name: string, fallback = '') => process.env[name] || fallback;
const { handler: app } = (await import(pathToFileURL(path.resolve(env('APP_HANDLER', 'build/handler.js'))).href)) as { handler: Handler };

// Pick one: your notes API speaks the protocol (docs/PROTOCOL.md), or it doesn't (./store.ts).
// Either way each call carries the reviewer's own session, never a server-wide token.
const store = env('NOTES_PROTOCOL_URL')
  ? remoteStore({ url: env('NOTES_PROTOCOL_URL'), label: 'Review notes', headers: ctx => ({ cookie: ctx?.req.headers.cookie }) })
  : reviewStore({ api: env('NOTES_API_URL', 'http://notes.internal'), noteUrl: id => `${env('ORIGIN')}/admin/review-notes?note=${id}` });

const { api, inject } = redlineMiddleware({
  store,
  // The release the pages come from (your image tag or commit): agents read source lines at it.
  build: env('REVIEW_BUILD') || undefined,
  // Redline keeps a small registry under <root>/.redline for local agents; nothing to keep here,
  // and the sources aren't in the image (the stamps are already repo-relative).
  root: path.join(os.tmpdir(), 'redline-review'),
});

function fail(res: http.ServerResponse, status: number, text: string) {
  if (res.headersSent) return res.end();
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

http.createServer((req, res) => {
  // Agents read review notes through your own API or MCP, with their own tokens. The dev
  // server's MCP endpoint has no business on a deployed site.
  if ((req.url ?? '').startsWith('/__redline/mcp')) return fail(res, 404, 'Not found');
  const done: Next = err => (err ? (console.error('[review]', err), fail(res, 500, 'Internal Error')) : fail(res, 404, 'Not found'));
  api(req, res, err => (err ? done(err) : inject(req, res, e => (e ? done(e) : app(req, res, done)))));
}).listen(Number(env('PORT', '3000')), env('HOST', '0.0.0.0'), () => console.log(`review frontend on :${env('PORT', '3000')}`));
