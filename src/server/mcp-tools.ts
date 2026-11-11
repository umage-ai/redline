// The dev server's own MCP tools (D65, D66), on top of the note tools of src/mcp.ts: what only a running
// dev server knows. Live pages (open tabs with the overlay): check_page, page_console, note_dom. Agent
// sessions (the agent option): attach, working_on, list_agent_sessions, get_agent_session. Served over
// POST /__redline/mcp only (the stdio `redline mcp` and .NET keep the note tools). Descriptions are
// prompt text for agents: short, and say when a tool can't help.

import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Note } from '../shared/types.ts';
import type { Content, ExtraTools } from '../mcp.ts';
import { ToolError } from '../mcp.ts';
import type { LiveHub, LivePage } from './live.ts';
import type { AgentRoutes } from './agent-hook.ts';

const text = (t: string): Content[] => [{ type: 'text', text: t }];
const NO_TAB = 'No browser tab has this app open with Redline loaded right now. Open the page in a browser (the dev server\'s URL) and try again, or use a browser MCP (Playwright) for a headless check.';

const LIVE_TOOLS = [
  {
    name: 'check_page',
    description: 'Request a page of this app from the dev server (status, content type, size) and collect the console errors of browser tabs that have it open now. Light: no headless browser; for a full run use a browser MCP.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The page\'s path, e.g. /settings' } }, required: ['path'] },
  },
  {
    name: 'page_console',
    description: 'Recent console errors (console.error, uncaught errors, unhandled rejections) from browser tabs that have this app open with Redline loaded. Says so when none is open.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Only tabs on this path, e.g. /settings' } } },
  },
  {
    name: 'note_dom',
    description: 'The DOM around a note\'s target as it is now, from a tab that has the note\'s page open: the element, its ancestors, text, HTML (cut at 4000 characters), size, position and key styles. Use it to find the element or to check that a fix landed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The note id' } }, required: ['id'] },
  },
];

const AGENT_TOOLS = [
  {
    name: 'working_on',
    description: 'Say which note you are on now: the reviewer sees it on the note and on your session\'s tab. Call it as you start each note; id null when you are done. For agent sessions started from Redline\'s agent toolbar.',
    inputSchema: { type: 'object', properties: { id: { type: ['string', 'null'], description: 'The note id, or null' }, session: { type: 'string', description: 'Your session id (REDLINE_AGENT_SESSION); not needed when Redline started you' } }, required: ['id'] },
  },
  {
    name: 'attach',
    description: 'Show the reviewer a file or link on your session\'s tab (📎): a screenshot you took, a file you made, a page to look at. path: a file in the project (images and text are shown); url: http(s). For agent sessions started from Redline\'s agent toolbar.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' }, title: { type: 'string', description: 'A caption' }, session: { type: 'string', description: 'Your session id (REDLINE_AGENT_SESSION); not needed when Redline started you' } } },
  },
  {
    name: 'list_agent_sessions',
    description: 'The agent sessions this dev server runs, yours and others: id, CLI, model and effort, state, prompt, notes, the note being worked on, worktree branch, attachments, last message.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_agent_session',
    description: 'One agent session in full, with the end of its transcript (for a terminal CLI: what its screen shows now).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The session id, e.g. s2' }, lines: { type: 'number', description: 'Transcript lines, default 40, at most 200' } }, required: ['id'] },
  },
];

const INSTRUCTIONS = 'Started from Redline\'s agent toolbar: call working_on with each note id as you start it, and attach to show the reviewer a screenshot or file. note_dom and page_console tell you what the open page shows now.';

/** A session in one line for list_agent_sessions. */
function sessionLine(s: Record<string, any>): string {
  const st = s.running ? s.status?.state : 'ended';
  const bits = [
    `${s.id} ${s.label ?? ''}`.trim(), s.cli, [s.model, s.effort].filter(Boolean).join('/'), st,
    s.task && `prompt: ${s.task}`, s.title && `"${s.title}"`, s.sent?.length && `notes: ${s.sent.join(', ')}`, s.focus && `on: ${s.focus}`,
    s.worktree && `branch ${s.worktree.branch}`, s.attachments && `${s.attachments} attached`, s.status?.msg && `last: ${s.status.msg}`,
  ];
  return '- ' + bits.filter(Boolean).join(' · ');
}

const pathOf = (p: string) => p.split('?')[0].split('#')[0];

/**
 * The extra tools for one MCP request. `session`: the agent session the call comes from, when Redline
 * started it (a header only trusted with the agent's own token; handler.ts checks that).
 */
export function devServerTools(o: { req: IncomingMessage; live: LiveHub; agent: AgentRoutes | null; notes: () => Promise<Note[]>; session?: string }): ExtraTools {
  const mcp = o.agent?.mcp;
  const tools = [...LIVE_TOOLS, ...(mcp ? AGENT_TOOLS : [])];
  const sessionFor = (args: Record<string, unknown>) => {
    const id = o.session || (typeof args.session === 'string' ? args.session : '') || '';
    if (!id) throw new ToolError('no agent session: this tool is for sessions started from Redline\'s agent toolbar (pass session if you know yours)');
    return id;
  };
  return {
    tools,
    instructions: mcp ? INSTRUCTIONS : undefined,
    async call(name, args) {
      switch (name) {
        case 'check_page': {
          const p = typeof args.path === 'string' ? args.path : '';
          if (!p.startsWith('/') || p.startsWith('//')) throw new ToolError('path must start with / (a page of this app)');
          const r = await selfGet(o.req, p);
          const tabs = await o.live.ask({ kind: 'console' }, (x: LivePage) => pathOf(x.path) === pathOf(p));
          const lines = [`GET ${p} → ${r.status}${r.type ? ` (${r.type}, ${r.size} bytes)` : ''}${r.error ? `: ${r.error}` : ''}`];
          if (!tabs.length) lines.push(`No open tab shows ${p}: console errors unknown. Open it in a browser to see them.`);
          for (const t of tabs) lines.push(...consoleLines(t));
          return text(lines.join('\n'));
        }
        case 'page_console': {
          const p = typeof args.path === 'string' && args.path ? args.path : undefined;
          const tabs = await o.live.ask({ kind: 'console' }, p ? (x: LivePage) => pathOf(x.path) === pathOf(p) : undefined);
          if (!tabs.length) return text(p && o.live.pages().length ? `No open tab shows ${p}. Open tabs: ${o.live.pages().map(x => x.path).join(', ')}` : NO_TAB);
          return text(tabs.flatMap(consoleLines).join('\n'));
        }
        case 'note_dom': {
          const id = String(args.id ?? '');
          const n = (await o.notes()).find(x => x.id === id);
          if (!n) throw new ToolError(`no note with id ${id}`);
          if (!n.target) return text(`Note ${id} has no element (a page note).`);
          const tabs = await o.live.ask({ kind: 'dom', target: n.target }, (x: LivePage) => x.page === n.page);
          if (!tabs.length) return text(`No open tab shows the note's page (${n.page}). ${o.live.pages().length ? `Open tabs: ${o.live.pages().map(x => x.path).join(', ')}.` : NO_TAB}`);
          const t = tabs.find(x => !(x.data as { missing?: boolean })?.missing) ?? tabs[0];
          const d = t.data as Record<string, unknown>;
          if (d?.missing) return text(`The note's element isn't on ${t.page.path} now (selector ${n.target.selector ?? '?'}). It may have moved, been renamed, or the page needs another state.`);
          return text(`${t.page.path} (${t.page.title || 'untitled'}), note ${id}:\n${JSON.stringify(d, null, 1)}`);
        }
      }
      if (!mcp) return undefined;
      switch (name) {
        case 'working_on': {
          const s = sessionFor(args);
          const note = args.id === null || args.id === '' ? null : typeof args.id === 'string' ? args.id : undefined;
          if (note === undefined) throw new ToolError('id must be a note id or null');
          if (note && !(await o.notes()).some(x => x.id === note)) throw new ToolError(`no note with id ${note}`);
          if (!mcp.focus(s, note)) throw new ToolError(`no agent session ${s}`);
          return text(note ? `Session ${s} is on note ${note}.` : `Session ${s}: no note now.`);
        }
        case 'attach': {
          const r = mcp.attach(sessionFor(args), { path: args.path, url: args.url, title: args.title });
          if ('error' in r) throw new ToolError(r.error);
          const a = r.attachment as { kind: string; path?: string; url?: string };
          return text(`Attached ${a.path ?? a.url} (${a.kind}); the reviewer sees it on your session's tab.`);
        }
        case 'list_agent_sessions': {
          const all = mcp.sessions();
          return text(all.length ? `${all.length} session${all.length === 1 ? '' : 's'}${o.session ? ` (you are ${o.session})` : ''}:\n${all.map(s => sessionLine(s as Record<string, any>)).join('\n')}` : 'No agent sessions.');
        }
        case 'get_agent_session': {
          const id = String(args.id ?? '');
          const s = mcp.sessions().find(x => x.id === id);
          if (!s) throw new ToolError(`no agent session ${id}`);
          const n = Math.max(1, Math.min(200, Number(args.lines) || 40));
          const tail = mcp.tail(id, n) ?? '';
          return text(`${sessionLine(s as Record<string, any>)}\n\n${JSON.stringify(s, null, 1)}\n\nTranscript (last ${n} lines):\n${tail || '(empty)'}`);
        }
      }
      return undefined;
    },
  };
}

function consoleLines(t: { page: LivePage; data: unknown }): string[] {
  const errs = ((t.data as { errors?: string[] })?.errors ?? []);
  return [`${t.page.path}: ${errs.length ? `${errs.length} console error${errs.length === 1 ? '' : 's'}` : 'no console errors'}`, ...errs.map(e => `  - ${e}`)];
}

/** GET a path from this same server (never another host): status, type and size, or the error. */
function selfGet(req: IncomingMessage, p: string): Promise<{ status: number; type?: string; size?: number; error?: string }> {
  // The address and port this request came in on: the server itself, whether it listens on IPv4 or IPv6.
  const port = req.socket.localPort, host = (req.socket.localAddress ?? '127.0.0.1').replace(/^::ffff:(?=\d)/, '');
  return new Promise(resolve => {
    const r = http.get({ host, port, path: p, headers: { host: req.headers.host ?? `localhost:${port}`, accept: 'text/html' }, timeout: 15_000 }, res => {
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '').split(';')[0], size }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'no answer in 15 s' }); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
  });
}
