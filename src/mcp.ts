// `redline mcp`: an MCP server (stdio) that gives any agent the notes through tools (D22).
// It talks to a running dev server's /__redline API, so it works with whatever store the
// app uses; with no dev server up, it reads and writes the markdown in <root>/.redline.
// JSON-RPC 2.0, one message per line; stdout carries only protocol, logs go to stderr.
// The same tools are served over HTTP by the dev server itself (POST /__redline/mcp, D37).

import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { Note } from './shared/types.ts';
import { API_BASE } from './shared/types.ts';
import { relativeAge } from './shared/age.ts';
import { headingFor, serializeNote } from './server/format.ts';
import { createStore, type NotePatch } from './server/store.ts';
import { readServers } from './server/registry.ts';

type StoredNote = Note & { file?: string };

export interface Backend {
  /** Where the notes come from, for the agent ("dev server http://…", ".redline/ (markdown)"). */
  label: string;
  list(): Promise<StoredNote[]>;
  update(id: string, patch: NotePatch): Promise<Note | null>;
  asset(name: string): Promise<{ type: string; data: Buffer } | null>;
}

export function httpBackend(url: string): Backend {
  const base = url.replace(/\/+$/, '') + API_BASE;
  return {
    label: `dev server ${url}`,
    async list() { return (await (await fetch(`${base}/notes`, { cache: 'no-store' })).json()).notes; },
    async update(id, patch) {
      const r = await fetch(`${base}/notes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: JSON.stringify(patch) });
      return r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error(`dev server: ${r.status} ${await r.text()}`));
    },
    async asset(name) {
      const r = await fetch(`${base}/assets/${name}`);
      return r.ok ? { type: r.headers.get('content-type') ?? 'image/png', data: Buffer.from(await r.arrayBuffer()) } : null;
    },
  };
}

export function fileBackend(root: string, dir = '.redline'): Backend {
  const store = createStore({ root, dir });
  return {
    label: `${dir}/ (markdown; no dev server running)`,
    list: () => store.list(),
    update: (id, patch) => store.update(id, patch),
    async asset(name) { const a = await store.asset(name); return a ? { type: a.type, data: Buffer.from(a.data) } : null; },
  };
}

async function reachable(url: string): Promise<boolean> {
  try { return (await fetch(url.replace(/\/+$/, '') + API_BASE + '/config', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

/** A live dev server from servers.json (or `url`), else the markdown files. */
export async function pickBackend(opts: { root: string; dir?: string; url?: string }): Promise<Backend> {
  const candidates = opts.url ? [opts.url] : (await readServers(opts.root, opts.dir)).map(s => s.url);
  for (const u of candidates) if (await reachable(u)) return httpBackend(u);
  if (opts.url) throw new Error(`no Redline dev server at ${opts.url}`);
  return fileBackend(opts.root, opts.dir);
}

/* ---------- tools ---------- */

const TOOLS = [
  {
    name: 'list_notes',
    description: 'List Redline UI feedback notes (comments, text changes, sketches the reviewer pinned on the running app). Start here; open notes are the work to do.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], description: 'Default: open' },
        page: { type: 'string', description: 'Only notes for this page path, e.g. /settings' },
        app: { type: 'string', description: 'Monorepos: only notes from this app folder, e.g. apps/web' },
      },
    },
  },
  {
    name: 'get_note',
    description: 'One note in full: where the element is in source (target.source file:line, components), selector/test id/text to find it, the instruction or text diff, the reply, and the screenshot (the target outlined in red; sketches drawn on top).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'update_note',
    description: 'Close or answer a note. After applying it: done=true and a one-line reply saying what changed and where (end with the short commit hash if you committed). If it is ambiguous or conflicts: leave done unset and put your question in reply; the reviewer sees replies live.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, reply: { type: 'string' }, done: { type: 'boolean' } },
      required: ['id'],
    },
  },
];

const INSTRUCTIONS = 'Redline holds UI feedback a reviewer pinned on the running app. list_notes, then get_note for each open one '
  + '(look at the screenshot), make the change in the code following the repo\'s conventions, then update_note with done=true and a '
  + 'one-line reply. Keep to what the note asks; apply notes on the same element oldest first. Text notes show the current and wanted text.';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function summary(n: StoredNote): string {
  const where = [n.page, n.app ? `app ${n.app}` : ''].filter(Boolean).join(' · ');
  const lines = [`- ${n.id} [${n.done ? 'done' : 'open'}] ${headingFor(n).replace(/^### \[[ x]\] /, '')}`, `  ${where} · ${relativeAge(n.at) ?? n.at}`];
  if (n.type === 'text') lines.push(`  - ${n.from ?? ''}`, `  + ${n.to ?? ''}`);
  if (n.body) lines.push(...n.body.split('\n').map(l => `  ${l}`));
  if (n.reply) lines.push(`  > ${n.reply}`);
  return lines.join('\n');
}

async function callTool(backend: Backend, name: string, args: Record<string, unknown>): Promise<Content[]> {
  if (name === 'list_notes') {
    const status = (args.status as string) ?? 'open';
    const notes = (await backend.list()).filter(n =>
      (status === 'all' || (status === 'done') === n.done) &&
      (!args.page || n.page === args.page) && (args.app === undefined || (n.app ?? '') === args.app));
    const head = `${notes.length} ${status === 'all' ? '' : status + ' '}note${notes.length === 1 ? '' : 's'} from ${backend.label}`;
    return [{ type: 'text', text: notes.length ? `${head}:\n\n${notes.map(summary).join('\n\n')}` : head + '.' }];
  }
  const id = String(args.id ?? '');
  if (name === 'get_note') {
    const n = (await backend.list()).find(x => x.id === id);
    if (!n) throw new ToolError(`no note with id ${id}`);
    const { file, ...note } = n;
    const out: Content[] = [{ type: 'text', text: `${file ? `In ${file}:\n\n` : ''}${serializeNote(note).trim()}` }];
    for (const rel of [n.screenshot]) {
      const a = rel ? await backend.asset(rel.split('/').pop()!) : null;
      if (a) out.push({ type: 'image', data: a.data.toString('base64'), mimeType: a.type });
    }
    return out;
  }
  if (name === 'update_note') {
    const patch: NotePatch = {};
    if (typeof args.reply === 'string') patch.reply = args.reply.replace(/\s*\n\s*/g, ' ').trim();
    if (typeof args.done === 'boolean') patch.done = args.done;
    if (!Object.keys(patch).length) throw new ToolError('give reply and/or done');
    const n = await backend.update(id, patch);
    if (!n) throw new ToolError(`no note with id ${id}`);
    return [{ type: 'text', text: summary(n) }];
  }
  throw new ToolError(`unknown tool ${name}`);
}

class ToolError extends Error {}

/* ---------- JSON-RPC ---------- */

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export type JsonRpcMessage = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

/**
 * One JSON-RPC message in, its response out (null for notifications). Shared by the stdio
 * server below and the dev server's HTTP endpoint (POST /__redline/mcp, handler.ts).
 */
export async function handleMcpMessage(msg: JsonRpcMessage, opts: { backend: () => Promise<Backend>; version?: string }): Promise<object | null> {
  const isCall = msg.id !== undefined;
  const reply = (result: unknown) => isCall ? { jsonrpc: '2.0', id: msg.id, result } : null;
  const fail = (code: number, message: string) => isCall ? { jsonrpc: '2.0', id: msg.id, error: { code, message } } : null;
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'redline', version: opts.version ?? '0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      try {
        return reply({ content: await callTool(await opts.backend(), name, (msg.params?.arguments as Record<string, unknown>) ?? {}) });
      } catch (err) {
        // Tool failures go back as results, so the agent can read and recover.
        return reply({ content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true });
      }
    }
    default:
      if (msg.method?.startsWith('notifications/')) return null;
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/* ---------- stdio ---------- */

export interface McpOptions { root: string; dir?: string; url?: string; input?: Readable; output?: Writable; version?: string }

/** Serve until the input closes. Picks the backend per call, so a dev server started later is used. */
export function runMcp(opts: McpOptions): Promise<void> {
  const out = opts.output ?? process.stdout;
  const send = (msg: unknown) => out.write(JSON.stringify(msg) + '\n');
  const rl = createInterface({ input: opts.input ?? process.stdin, crlfDelay: Infinity });
  const pending: Promise<unknown>[] = [];
  const backend = () => pickBackend(opts);

  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    pending.push(handleMcpMessage(msg, { backend, version: opts.version }).then(r => { if (r) send(r); }).catch(err => console.error('[redline mcp]', err)));
  });
  return new Promise(resolve => rl.on('close', () => { void Promise.all(pending).then(() => resolve()); }));
}
