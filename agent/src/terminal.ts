// The agent's terminal (D53): xterm.js in the page the agent window frames (/__redline/agent/terminal).
// Its own document keeps it out of the app's key handlers and the overlay's shield, which would
// otherwise swallow or re-send the keys a terminal needs. Output comes over SSE, keys go back as POSTs.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import css from '@xterm/xterm/css/xterm.css';
import { API_BASE } from '../../src/shared/types.ts';

const BASE = `${API_BASE}/agent`;

document.head.append(Object.assign(document.createElement('style'), {
  textContent: css + `
.start { position: absolute; inset: 0; display: grid; place-items: center; background: #131316; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; color: #a3a3ad; text-align: center; }
.start button { font: inherit; font-weight: 650; color: #fff; background: #ff2d55; border: 0; border-radius: 8px; padding: 8px 16px; cursor: pointer; margin-top: 10px; }
.start code { color: #ececf1; }
.start .err { color: #ff6b85; max-width: 420px; margin-top: 8px; }`,
}));

async function main() {
  const setup = await (await fetch(`${BASE}/info`)).json() as { token: string; command: string; sessions: { id: string; label: string }[] };
  const token = setup.token;
  // The session this page shows (`?id=`, set by the toolbar), or the newest; none yet: Start makes one.
  const asked = new URLSearchParams(location.search).get('id');
  const session = setup.sessions.find(x => x.id === asked) ?? setup.sessions[setup.sessions.length - 1];
  const id = session?.id;

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace',
    fontSize: 13, cursorBlink: true, scrollback: 5000, allowProposedApi: false,
    theme: { background: '#131316', foreground: '#ececf1', cursor: '#ff2d55', selectionBackground: '#3a3a46' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.getElementById('t')!;
  term.open(host);
  // The server answers DA1 (and the OSC 7501 query) itself, in order (D53): xterm must not answer it again.
  term.parser.registerCsiHandler({ final: 'c' }, () => true);
  const refit = () => { try { fit.fit(); } catch { /* not laid out yet */ } };
  refit();

  // Keys go out in order: one request at a time, with whatever was typed meanwhile batched.
  let pending = '', sending = false;
  const post = (p: string, body: Record<string, unknown>) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': token }, body: JSON.stringify(id ? { ...body, id } : body) });
  async function pump() {
    if (sending || !pending) return;
    sending = true;
    const data = pending; pending = '';
    try { await post('/input', { data }); } catch { /* dropped: the server is gone */ }
    sending = false;
    void pump();
  }
  term.onData(d => { pending += d; void pump(); });
  let lastAck = 0;
  term.onKey(() => { if (Date.now() - lastAck > 2000) { lastAck = Date.now(); parent.postMessage({ type: 'ack' }, location.origin); } });
  term.onResize(({ cols, rows }) => void post('/resize', { cols, rows }));
  new ResizeObserver(refit).observe(host);
  window.addEventListener('message', e => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === 'fit') refit();
    if (e.data?.type === 'focus') { refit(); term.focus(); }
  });

  // The start screen: shown while the agent isn't running.
  const start = document.createElement('div');
  start.className = 'start';
  document.body.append(start);
  function showStart(exitCode?: number | null, error?: string) {
    start.replaceChildren();
    const box = document.createElement('div');
    const what = document.createElement('div');
    what.append(exitCode !== undefined ? `${setup.command} exited (${exitCode ?? '?'})` : 'Run ', exitCode === undefined ? Object.assign(document.createElement('code'), { textContent: setup.command }) : '', exitCode === undefined ? ' here, in this project' : '');
    const btn = document.createElement('button');
    btn.textContent = exitCode !== undefined ? 'Restart' : 'Start';
    btn.onclick = async () => {
      btn.disabled = true;
      refit();
      const r = await post('/start', { cols: term.cols, rows: term.rows });
      if (!r.ok) return showStart(exitCode, (await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
      // A new session (none was here): this page shows it from now on, and the toolbar too.
      const started = (await r.json().catch(() => null))?.id as string | undefined;
      if (started && started !== id) { parent.postMessage({ type: 'session', id: started }, location.origin); location.replace(`?id=${encodeURIComponent(started)}`); }
    };
    box.append(what, btn);
    if (error) box.append(Object.assign(document.createElement('div'), { className: 'err', textContent: error }));
    start.append(box);
    start.style.display = '';
  }
  const hideStart = () => { start.style.display = 'none'; term.focus(); };

  if (!id) return showStart();
  const es = new EventSource(`${BASE}/stream?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
  es.addEventListener('hello', e => {
    const h = JSON.parse((e as MessageEvent).data);
    term.reset();
    if (h.scrollback) term.write(h.scrollback);
    if (h.running) { hideStart(); void post('/resize', { cols: term.cols, rows: term.rows }); }
    else showStart(h.exitCode);
  });
  es.addEventListener('start', () => { term.reset(); hideStart(); });
  es.addEventListener('data', e => term.write(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('exit', e => showStart(JSON.parse((e as MessageEvent).data).exitCode));
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) showStart(undefined, 'Lost the dev server; reload the page.'); };
}

void main();
