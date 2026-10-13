// Framework-free entry for other Node dev servers (Express, custom http):
//
//   import { redlineMiddleware } from '@umage-ai/redline/server'
//   const { api, inject } = redlineMiddleware({ serverRoot: process.cwd() })
//   app.use(api); app.use(inject)

import { clientFile } from '../vite.ts';
import { createHandler, type RedlineOptions } from './handler.ts';

export function redlineMiddleware(opts: RedlineOptions & { serverRoot?: string } = {}) {
  return createHandler({ ...opts, serverRoot: opts.serverRoot ?? process.cwd(), clientFile });
}

export { createStore } from './store.ts';
export { parsePage, serializePage } from './format.ts';
export type { RedlineOptions };
