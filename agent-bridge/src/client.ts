// The bridge's browser client (D63): /info, the status feed, and the calls a viewer makes. No
// dependencies, no DOM beyond fetch and EventSource. Same origin as the server (the bridge refuses others).
//
//   const agents = await bridgeClient('/agent');
//   agents.watch(group => render(group.sessions));
//   await agents.send('Fix the failing test', { cli: 'claude-code' });

import type { CliInfo, GroupInfo, SessionInfo } from './types.ts';

export type { CliInfo, GroupInfo, SessionInfo };

/** What GET /info answers: the group, the CLIs, the token, and any fields the host added. */
export interface BridgeInfo extends GroupInfo {
  command: string; clis: CliInfo[]; cli: string; token: string; approve: boolean;
  defaults: { sessions?: 'shared' | 'fresh'; model?: string; effort?: string };
  [extra: string]: unknown;
}

export interface SendOptions {
  /** A session: in 'shared' mode the one to prompt; omitted: the newest (shared) or a new one (fresh). */
  id?: string;
  /** The CLI a new session runs (an id from `clis`), its model and effort (only values /info offers). */
  cli?: string; model?: string; effort?: string;
  /** Ids the prompt is about (the host's), a tab name and a label for the prompt. */
  notes?: string[]; title?: string; task?: string;
}

/** A client for the bridge mounted at `base` (`/agent`, Redline's `/__redline/agent`). */
export async function bridgeClient(base: string) {
  let setup = await getInfo(base);
  const post = async <T = Record<string, unknown>>(p: string, body: Record<string, unknown> = {}): Promise<T> => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': setup.token }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
    return r.json();
  };
  return {
    get info() { return setup; },
    /** Reads /info again (a new token after the server restarted). */
    async refresh() { setup = await getInfo(base); return setup; },
    post,
    /**
     * The status feed: `onGroup` with every session whenever one changes, `onClis` when an ACP agent's
     * models arrive. Reconnects by itself; a stale token (another server process) re-reads /info first.
     * Returns a function that closes it.
     */
    watch(onGroup: (g: GroupInfo) => void, onClis?: (c: CliInfo[]) => void, onInfo?: (i: BridgeInfo) => void): () => void {
      let es: EventSource | null = null, closed = false;
      const connect = () => {
        es?.close();
        if (closed) return;
        es = new EventSource(`${base}/stream?status=1&token=${encodeURIComponent(setup.token)}`);
        for (const ev of ['hello', 'status']) es.addEventListener(ev, e => onGroup(JSON.parse((e as MessageEvent).data)));
        es.addEventListener('clis', e => { setup.clis = JSON.parse((e as MessageEvent).data); onClis?.(setup.clis); });
        es.onerror = async () => {
          if (es?.readyState !== EventSource.CLOSED || closed) return;
          try { setup = await getInfo(base); onInfo?.(setup); setTimeout(connect, 1000); } catch { /* down: retried on the next call */ }
        };
      };
      connect();
      return () => { closed = true; es?.close(); };
    },
    /** A session's output and status (terminal viewers): `hello` (with scrollback), `data`, `status`, `start`, `exit`. */
    stream(id: string): EventSource { return new EventSource(`${base}/stream?id=${encodeURIComponent(id)}&token=${encodeURIComponent(setup.token)}`); },
    send: (text: string, o: SendOptions = {}) => post<{ ok: true; id: string }>('/send', { text, ...o }),
    start: (o: Omit<SendOptions, 'notes' | 'title' | 'task'> & { cols?: number; rows?: number } = {}) => post<SessionInfo>('/start', o),
    /** Picks option `index` of the menu the session shows (`text`: typed into an input option). */
    choose: (id: string, index: number, text?: string) => post('/choose', { id, index, ...(text === undefined ? {} : { text }) }),
    answer: (id: string, choice: 'allow' | 'deny') => post('/answer', { id, choice }),
    input: (id: string, data: string) => post('/input', { id, data }),
    resize: (id: string, cols: number, rows: number) => post('/resize', { id, cols, rows }),
    ack: (id: string) => post('/ack', { id }),
    mode: (mode: 'shared' | 'fresh') => post<GroupInfo>('/mode', { mode }),
    /** Stops and closes a session; no id: every one. */
    end: (id?: string) => post('/end', id ? { id } : {}),
  };
}
export type BridgeClient = Awaited<ReturnType<typeof bridgeClient>>;

async function getInfo(base: string): Promise<BridgeInfo> {
  const r = await fetch(`${base}/info`);
  if (!r.ok) throw new Error(`agent bridge: HTTP ${r.status}`);
  return r.json();
}
