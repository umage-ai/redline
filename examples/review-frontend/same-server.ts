// Option B (README.md): Redline in your one production server, for reviewers only. No gateway rule
// and no second image; the price is that the build is the same for everyone (with source stamps,
// every visitor's HTML carries file paths and component names; without them, notes have no file:line).
//
//   const { api, inject } = redlineMiddleware({ store, build: process.env.REVIEW_BUILD })
//   app.use(reviewersOnly(api, isReviewer))
//   app.use(reviewersOnly(inject, isReviewer))
//
// Everyone else never reaches Redline: no script in their pages, and /__redline/* falls through to
// your app (a 404). The store still checks again on every call (store.ts), so this is the first
// gate, not the only one.

import type { IncomingMessage, ServerResponse } from 'node:http';

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/**
 * Run `mw` only for requests `isReviewer` accepts (your session check: signed in, allowed to review,
 * switch on). A failing check counts as "no": Redline is a convenience, the app is not.
 */
export function reviewersOnly(mw: Middleware, isReviewer: (req: IncomingMessage) => boolean | Promise<boolean>): Middleware {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => isReviewer(req))
      .catch(() => false)
      .then(ok => (ok ? mw(req, res, next) : next()));
  };
}
