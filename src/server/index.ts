// Framework-free entry for other Node dev servers (Express, custom http):
//
//   import { redlineMiddleware } from '@umage.ai/redline/server'
//   const { api, inject } = redlineMiddleware({ serverRoot: process.cwd() })
//   app.use(api); app.use(inject)

import { clientFile } from '../vite.ts';
import { createHandler, type RedlineOptions } from './handler.ts';

export function redlineMiddleware(opts: RedlineOptions & { serverRoot?: string } = {}) {
  return createHandler({ ...opts, serverRoot: opts.serverRoot ?? process.cwd(), clientFile });
}

export { createStore, newId, stamp, validId, cleanPatch } from './store.ts';
export { remoteStore } from './remote.ts';
export type { RemoteStoreOptions, RemoteStore } from './remote.ts';
export { notesProtocol } from './protocol.ts';
export type { ProtocolOptions } from './protocol.ts';
export { parsePage, serializePage } from './format.ts';
export { defaultWriters, markupWriter, staticHtmlWriter } from './writers.ts';
export { decodeEntities, editAt, editUnique, tokenize } from './edit.ts';
export type { Token, Edit, Nth } from './edit.ts';
export type { RedlineOptions };
export type { RedlineHooks } from './handler.ts';
export type { NoteStore, NotePatch } from './store.ts';
export type { SourceWriter, EditRequest, EditResult, WriterContext, Inspection } from './writers.ts';
export type { Note, NewNoteRequest, Target, SourceLoc } from '../shared/types.ts';
export type { RedlineApi, RedlineButton, RedlinePanelSection, RedlinePanelState, RedlinePageKey, RedlineEvents, RedlineExtension, RedlineMode } from '../shared/extension.ts';
