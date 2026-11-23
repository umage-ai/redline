// The voice plugin's overlay extension (D71), served at <base>/p/voice/extension.js.
//
// Voice note: the Voice mode (V) picks an element like Comment; a toolbar takes its place while you talk
// (timer, level, the live transcript in its card); Enter saves. The server transcribes it and the note's
// body becomes the transcript; cards show where that is (waiting, transcribing, done, failed + retry).
//
// Session recorder: Record (R, or alt+shift+v from anywhere) opens a toolbar for talking while you show:
// Point (P) picks elements and keeps picking, Draw (D) inks on the page, Shot (S) takes the viewport,
// Browse (B) lets the app work and logs clicks and route changes; Space pauses, Enter finishes. Every action is
// stamped with the time on the recording; the server lines them up with the transcript in session.md.

import type { RedlineApi, RedlineToolbar } from '../../src/shared/extension.ts';
import type { NewNoteRequest, Note, Target } from '../../src/shared/types.ts';
import { base64, liveSupported, micSupported, record, toWav, type Recording } from './recorder.ts';

const BASE = new URL('./', import.meta.url).href;
const INK = '#ff2d55';

interface Config {
  notes: boolean; sessions: boolean; live: 'auto' | boolean; browser: boolean; engines: string[];
  wav: boolean; language: string | null; maxSeconds: number; key: string | false; hotkey: string | false;
}
interface VoiceMeta { audio: string; duration?: number; status: string; engine?: string; error?: string }
interface SessionMeta { id: string; status: string; engine?: string; error?: string; duration?: number; audio?: string }

type Ev = { kind: string; t: number; url?: string; target?: Target; whole?: boolean; shot?: string; title?: string };

// ---- small DOM helpers ----
type Kids = (Node | string | null | undefined | false)[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Kids): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const clock = (s: number) => { const x = Math.max(0, Math.floor(s)); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
const short = (t?: Target, whole?: boolean) => whole || !t ? 'the whole page' : `${t.tag ?? 'element'}${t.text ? ` “${t.text.slice(0, 30)}${t.text.length > 30 ? '…' : ''}”` : ''}`;
const post = async (p: string, body: unknown) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'x-redline': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};

const CSS = `
.vx { display: flex; align-items: center; gap: 2px; }
.vx .vx-dot { width: 9px; height: 9px; border-radius: 50%; background: ${INK}; flex: none; animation: vx-pulse 1.2s ease-in-out infinite; }
.vx .vx-dot.paused { animation: none; background: var(--fg-3); }
.vx .vx-time { font: 600 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--fg); min-width: 34px; }
.vx .vx-meter { width: 36px; height: 6px; border-radius: 3px; background: var(--bg-3); overflow: hidden; flex: none; }
.vx .vx-meter i { display: block; height: 100%; width: 0; background: ${INK}; transition: width .08s; }
.vx .vx-what { color: var(--fg-2); font-size: 12px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 6px; }
.vx .vx-live { display: flex; align-items: center; gap: 8px; padding: 0 8px 0 4px; }
.vx button.on { background: color-mix(in srgb, ${INK} 22%, transparent); color: var(--fg); }
.vx button.primary { color: var(--fg); font-weight: 650; }
.vx button.danger { color: ${INK}; }
.vx .vx-sep { width: 1px; align-self: stretch; margin: 4px 4px; background: var(--line); }
@keyframes vx-pulse { 50% { opacity: .35; } }
`;
const CARD_CSS = `
.vx-card { font-size: 13px; line-height: 1.45; max-width: 520px; }
.vx-card .said { color: var(--fg); }
.vx-card .now { color: var(--fg-3); }
.vx-card .hint { color: var(--fg-2); }
.vx-card .evs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.vx-card .ev { font-size: 11.5px; padding: 1px 7px; border-radius: 9px; background: var(--bg-3); color: var(--fg-2); white-space: nowrap; }
.vx-card .keys { margin-top: 8px; color: var(--fg-3); font-size: 12px; }
.vx-card .err { color: ${INK}; }
`;
const DECO_CSS = `
.vx-st { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; font-size: 11.5px; color: var(--fg-2); }
.vx-st .chip2 { padding: 1px 7px; border-radius: 9px; background: var(--bg-3); white-space: nowrap; }
.vx-st .chip2.busy::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 50%; border: 2px solid var(--fg-3); border-top-color: var(--fg); animation: vx-spin .8s linear infinite; vertical-align: -1px; }
.vx-st .chip2.bad { color: ${INK}; }
.vx-st audio { height: 26px; max-width: 100%; }
@keyframes vx-spin { to { transform: rotate(360deg); } }
`;
const style = (css: string) => h('style', {}, css);

export default async function voiceExtension(rl: RedlineApi) {
  if (!(rl.version >= 8)) { console.warn('[redline-voice] needs @umage.ai/redline with extension API v8 (0.11 or later)'); return; }
  let cfg: Config;
  try { cfg = await (await fetch(BASE + 'config')).json(); } catch (e) { console.warn('[redline-voice] no config:', e); return; }
  const liveWanted = cfg.live === true || (cfg.live === 'auto' && liveSupported());
  const serverEngine = cfg.engines.find(e => e !== 'browser');

  // ---- note cards: transcript status, the recording, retry ----
  const statusChip = (status: string, engine?: string, error?: string) => {
    const [cls, text] = status === 'done' ? ['', `Transcribed${engine ? ` · ${engine}` : ''}`]
      : status === 'transcribing' ? ['busy', `Transcribing${engine ? '' : serverEngine ? ` · ${serverEngine}` : ''}…`]
      : status === 'queued' ? ['busy', 'Waiting to transcribe…']
      : status === 'failed' ? ['bad', 'Transcript failed']
      : ['', 'No transcript'];
    return h('span', { class: `chip2 ${cls}`, title: error ?? undefined }, text);
  };
  rl.addCardDecorator({
    id: 'voice',
    render(note: Note, el: HTMLElement) {
      const v = note.meta?.voice as VoiceMeta | undefined;
      const s = note.meta?.session as SessionMeta | undefined;
      if (!v && !s) return;
      const row = h('div', { class: 'vx-st' }, style(DECO_CSS), statusChip(v?.status ?? s!.status, v?.engine ?? s?.engine, v?.error ?? s?.error));
      const src = v ? `${BASE}audio/${v.audio.split('/').pop()}` : s?.audio ? `${BASE}sessions/${s.id}/${s.audio}` : null;
      if (src) row.append(h('audio', { controls: true, preload: 'none', src }));
      el.append(row);
    },
  });
  rl.addCardAction({
    id: 'voice-retry', label: '↻', title: 'Transcribe again',
    show: n => ['failed', 'none'].includes(((n.meta?.voice ?? n.meta?.session) as { status?: string } | undefined)?.status ?? ''),
    async onClick(n) {
      try { await post(`retry/${(n.meta?.session as SessionMeta | undefined)?.id ?? n.id}`, {}); rl.toast('Transcribing again…'); void rl.refresh(); }
      catch (e) { rl.toast(`Couldn't retry: ${(e as Error).message}`, true); }
    },
  });

  // Shown in the toolbar's card (a toast would sit behind it), and kept there until the next try.
  const NO_REC = 'This browser can’t record audio here (it needs https or localhost).';
  const micMessage = (e: unknown) => {
    const name = (e as DOMException)?.name;
    return name === 'NotAllowedError' || name === 'SecurityError' ? 'The microphone is blocked for this page. Allow it in the address bar, then try again.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone found. Connect one, then try again.'
      : name === 'NotReadableError' ? 'The microphone is in use by another app, or the system blocks it.'
      : `Couldn’t start recording: ${(e as Error)?.message ?? e}`;
  };
  // Space and Enter on the app's own focused button or link are the app's (Browse), not the recorder's.
  const appFocused = () => { const a = document.activeElement; return !!a && a !== document.body && a !== document.documentElement && !a.tagName.toLowerCase().startsWith('redline-'); };
  const ticker = (fn: () => void) => { const id = setInterval(fn, 200); return () => clearInterval(id); };

  // ---- voice notes ----
  if (cfg.notes) {
    let noteErr: string | null = null;
    let vn: { rec: Recording; req: Promise<NewNoteRequest>; what: string; saving: boolean; stopTick: () => void; timer?: HTMLElement; meter?: HTMLElement } | null = null;
    let bar: RedlineToolbar;

    const finish = async (save: boolean) => {
      const cur = vn;
      if (!cur || cur.saving) return;
      if (!save) { cur.stopTick(); cur.rec.cancel(); vn = null; bar.hide(); return; }
      cur.saving = true;
      bar.render();
      try {
        const out = await cur.rec.stop();
        cur.stopTick();
        if (out.duration < 0.4) throw new Error('nothing recorded');
        const [request, audio, wav] = await Promise.all([cur.req, base64(out.blob), cfg.wav ? toWav(out.blob).then(base64).catch(() => undefined) : undefined]);
        await post('notes', { request, audio: { data: audio, mime: out.mime }, wav, duration: out.duration, live: { text: out.text, segments: out.segments } });
        rl.toast(serverEngine ? `Voice note saved; ${serverEngine} is transcribing it.` : 'Voice note saved.');
        void rl.refresh();
      } catch (e) {
        rl.toast(`Couldn't save the voice note: ${(e as Error).message}`, true);
      } finally {
        vn = null;
        bar.hide();
      }
    };

    bar = rl.addToolbar({
      id: 'voice-note', title: 'Voice note', backTitle: 'Cancel the voice note (Esc)',
      render(el) {
        if (!vn) {
          el.append(h('div', { class: 'vx' }, style(CSS), h('span', { class: 'vx-what' }, noteErr ? 'Can’t record' : 'Pick an element with Voice (V) first.'),
            noteErr ? h('button', { title: 'Close (Esc)', onclick: () => bar.hide() }, 'Close') : null));
          return;
        }
        const timer = h('span', { class: 'vx-time' }, clock(vn.rec.elapsed()));
        const meter = h('i');
        vn.timer = timer; vn.meter = meter;
        el.append(h('div', { class: 'vx' }, style(CSS),
          h('span', { class: 'vx-live' }, h('span', { class: 'vx-dot' }), timer, h('span', { class: 'vx-meter' }, meter)),
          h('span', { class: 'vx-what', title: vn.what }, `On ${vn.what}`),
          h('div', { class: 'vx-sep' }),
          h('button', { class: 'primary', disabled: vn.saving, title: 'Stop and save (Enter)', onclick: () => void finish(true) }, vn.saving ? 'Saving…' : 'Save', h('kbd', {}, '↵')),
          h('button', { disabled: vn.saving, title: 'Throw it away (Esc)', onclick: () => void finish(false) }, 'Cancel'),
        ));
      },
      attached(card) {
        if (!vn) { if (noteErr) card.append(h('div', { class: 'vx-card' }, style(CARD_CSS), h('div', { class: 'err' }, noteErr))); return; }
        const live = vn.rec.live();
        const said = live.segments.map(s => s.text).join(' ');
        card.append(h('div', { class: 'vx-card' }, style(CARD_CSS),
          said || live.interim
            ? h('div', {}, h('span', { class: 'said' }, said), ' ', h('span', { class: 'now' }, live.interim))
            : h('div', { class: 'hint' }, liveWanted && live.available ? 'Listening… talk about the element.' : `Talk now.${serverEngine ? ` ${serverEngine} writes the transcript when you save.` : ''}`),
          live.error ? h('div', { class: 'err' }, `Live transcript: ${live.error}`) : null,
          h('div', { class: 'keys' }, `Enter saves · Esc cancels · up to ${clock(cfg.maxSeconds)}`)));
      },
      onKey(e) { if (e.key === 'Enter') { void finish(true); return true; } return false; },
      onEscape() { if (!vn) { bar.hide(); return true; } void finish(false); return true; },
      onHide() { noteErr = null; if (vn && !vn.saving) { vn.stopTick(); vn.rec.cancel(); vn = null; } },
    });

    rl.addMode({
      id: 'voice', label: 'Voice', key: cfg.key || undefined,
      title: 'Voice note: pick an element (Alt: its parent, Shift: the whole page), then talk',
      async onPick({ el, whole, x, y }) {
        if (vn) return;
        if (!micSupported()) { noteErr = NO_REC; bar.show(); return; }
        // The screenshot is taken now, while the page looks like what was picked.
        const req = rl.noteRequest({ el, whole, x, y });
        let rec: Recording;
        try { rec = await record({ live: liveWanted, lang: cfg.language, onChange: () => bar.render() }); }
        catch (e) { noteErr = micMessage(e); bar.show(); return; }
        noteErr = null;
        const what = el && !whole ? short(rl.describe(el)) : 'the whole page';
        const stopTick = ticker(() => {
          if (!vn) return;
          if (vn.timer) vn.timer.textContent = clock(vn.rec.elapsed());
          if (vn.meter) vn.meter.style.width = `${Math.round(vn.rec.level() * 100)}%`;
          if (vn.rec.elapsed() >= cfg.maxSeconds) void finish(true);
        });
        vn = { rec, req, what, saving: false, stopTick };
        bar.show();
      },
    });
  }

  // ---- the session recorder ----
  if (!cfg.sessions) return;

  interface Session {
    rec: Recording; started: string; req: Promise<NewNoteRequest>;
    events: Ev[]; shots: Record<string, string>; n: number;
    mode: 'browse' | 'point' | 'draw'; saving: boolean; stopTick: () => void;
    timer?: HTMLElement; meter?: HTMLElement; armDiscard?: number;
  }
  let ses: Session | null = null;
  let sesErr: string | null = null;
  let bar: RedlineToolbar;
  let overlayMode = 'idle';

  const at = () => Math.round((ses?.rec.elapsed() ?? 0) * 1000);
  const log = (e: Ev) => { if (!ses || ses.rec.paused()) return; ses.events.push(e); bar.render(); };
  const shoot = async (opts: Parameters<RedlineApi['screenshot']>[0]) => {
    if (!ses) return undefined;
    const png = await rl.screenshot(opts);
    if (!png || !ses) return undefined;
    const id = `s${++ses.n}`;
    ses.shots[id] = png;
    return id;
  };

  const setStatus = () => rl.setStatus('voice', ses ? {
    color: ses.rec.paused() ? '#a3a3ad' : INK, title: ses.rec.paused() ? 'Session recording paused' : 'Recording a review session',
    toolbar: 'outline', launcher: 'ring', pulse: !ses.rec.paused(), onClick: () => bar.show(),
  } : null);

  // Ink: a layer of its own over the page while Draw is on; a stroke group is saved ~1 s after the last stroke.
  const ink = (() => {
    let host: HTMLElement | null = null, svg: SVGSVGElement | null = null, path: SVGPathElement | null = null;
    let pts: string[] = [], firstT = -1, timer: ReturnType<typeof setTimeout> | undefined;
    const NS = 'http://www.w3.org/2000/svg';
    const commit = async () => {
      if (!svg || !host || !svg.childElementCount || !ses) return;
      const t = firstT; firstT = -1;
      const b = svg.getBBox();
      host.style.visibility = 'hidden';
      const under = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      const snap = svg.cloneNode(true) as SVGSVGElement;
      const shot = await shoot({ sketch: snap, crop: false });
      if (host) host.style.visibility = '';
      log({ kind: 'draw', t, url: location.href, shot, target: under && under !== document.documentElement && under !== document.body ? rl.describe(under) : undefined });
      svg?.replaceChildren();
    };
    const stop = (e: Event) => e.stopPropagation();
    return {
      on() {
        if (host) return;
        host = h('div', { style: { position: 'fixed', inset: '0', zIndex: '2147483646', cursor: 'crosshair', touchAction: 'none' } });
        host.setAttribute('data-redline-voice-ink', '');
        svg = document.createElementNS(NS, 'svg');
        const size = () => { svg!.setAttribute('width', String(innerWidth)); svg!.setAttribute('height', String(innerHeight)); svg!.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`); };
        size();
        svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
        host.append(svg);
        for (const t of ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu']) host.addEventListener(t, stop);
        host.addEventListener('pointerdown', e => {
          e.stopPropagation(); e.preventDefault();
          clearTimeout(timer);
          if (firstT < 0) firstT = at();
          host!.setPointerCapture(e.pointerId);
          pts = [`M${e.clientX},${e.clientY}`];
          path = document.createElementNS(NS, 'path');
          for (const [k, v] of Object.entries({ fill: 'none', stroke: INK, 'stroke-width': '4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, v);
          path.setAttribute('d', pts[0]);
          svg!.append(path);
        });
        host.addEventListener('pointermove', e => {
          e.stopPropagation();
          if (!path) return;
          pts.push(`L${e.clientX},${e.clientY}`);
          path.setAttribute('d', pts.join(''));
        });
        host.addEventListener('pointerup', e => {
          e.stopPropagation();
          path = null;
          timer = setTimeout(() => void commit(), 1000);
        });
        document.documentElement.append(host);
      },
      async off() {
        clearTimeout(timer);
        await commit();
        host?.remove(); host = null; svg = null; path = null;
      },
    };
  })();

  const setMode = async (m: Session['mode']) => {
    if (!ses) return;
    if (ses.mode === 'draw' && m !== 'draw') await ink.off();
    ses.mode = m;
    // setMode toggles: only switch when the overlay's mode isn't already the one wanted.
    if (m === 'point') { if (overlayMode !== 'ext:voice-point') rl.setMode('ext:voice-point'); }
    else if (overlayMode !== 'idle') rl.setMode('idle');
    if (m === 'draw') ink.on();
    bar.render();
  };

  rl.addMode({
    id: 'voice-point', label: 'Point', toolbar: 'voice-session', stay: true,
    title: 'Point at elements while you talk (the session recorder)',
    async onPick({ el, whole, x, y }) {
      if (!ses) return;
      const t = at();
      const target = el && !whole ? rl.describe(el, x, y) : undefined;
      const shot = await shoot(el && !whole ? { el } : { crop: false });
      log({ kind: 'point', t, url: location.href, target, whole: !target || undefined, shot });
    },
    onStop() { if (ses?.mode === 'point') { ses.mode = 'browse'; bar.render(); } },
  });

  const start = async () => {
    if (ses) return;
    if (!micSupported()) { sesErr = NO_REC; bar.render(); return; }
    let rec: Recording;
    try { rec = await record({ live: liveWanted, lang: cfg.language, onChange: () => bar.render() }); }
    catch (e) { sesErr = micMessage(e); bar.render(); return; }
    sesErr = null;
    const stopTick = ticker(() => {
      if (!ses) return;
      if (ses.timer) ses.timer.textContent = clock(ses.rec.elapsed());
      if (ses.meter) ses.meter.style.width = `${Math.round(ses.rec.level() * 100)}%`;
    });
    ses = { rec, started: new Date().toISOString(), req: rl.noteRequest({ whole: true, screenshot: false }), events: [], shots: {}, n: 0, mode: 'browse', saving: false, stopTick };
    setStatus();
    bar.render();
  };

  const togglePause = () => {
    if (!ses) return void start();
    if (ses.rec.paused()) { ses.rec.resume(); ses.events.push({ kind: 'resume', t: at() }); }
    else { ses.events.push({ kind: 'pause', t: at() }); ses.rec.pause(); }
    setStatus();
    bar.render();
  };

  const end = async (save: boolean) => {
    const cur = ses;
    if (!cur || cur.saving) return;
    if (!save) {
      if (!cur.armDiscard || Date.now() - cur.armDiscard > 3000) { cur.armDiscard = Date.now(); bar.render(); setTimeout(() => bar.render(), 3100); return; }
      await ink.off(); cur.stopTick(); cur.rec.cancel(); ses = null; if (overlayMode !== 'idle') rl.setMode('idle'); setStatus(); bar.render();
      rl.toast('Session discarded.');
      return;
    }
    if (cur.mode === 'draw') await ink.off();
    cur.saving = true;
    if (overlayMode !== 'idle') rl.setMode('idle');
    bar.render();
    try {
      const out = await cur.rec.stop();
      cur.stopTick();
      const [request, audio, wav] = await Promise.all([cur.req, base64(out.blob), cfg.wav ? toWav(out.blob).then(base64).catch(() => undefined) : undefined]);
      const r = await post('sessions', {
        request, started: cur.started, duration: out.duration, audio: { data: audio, mime: out.mime }, wav,
        events: cur.events, shots: cur.shots, live: { text: out.text, segments: out.segments },
      });
      rl.toast(`Session saved to ${r.dir}${serverEngine ? `; ${serverEngine} is transcribing it` : ''}.`, { ms: 6000 });
      void rl.refresh();
      ses = null;
      setStatus();
      bar.hide();
    } catch (e) {
      cur.saving = false;
      rl.toast(`Couldn't save the session: ${(e as Error).message}`, true);
      bar.render();
    }
  };

  bar = rl.addToolbar({
    id: 'voice-session', title: 'Session', hotkey: cfg.hotkey || undefined, backTitle: 'Back to the toolbar (Esc); the recording goes on',
    render(el) {
      const box = h('div', { class: 'vx' }, style(CSS));
      el.append(box);
      if (!ses) {
        box.append(h('button', { class: 'primary', title: 'Start recording (Space)', onclick: () => void start() }, h('span', { class: 'vx-dot paused', style: { background: INK } }), sesErr ? 'Try again' : 'Start recording', h('kbd', {}, 'Space')));
        return;
      }
      const paused = ses.rec.paused();
      const timer = h('span', { class: 'vx-time' }, clock(ses.rec.elapsed()));
      const meter = h('i');
      ses.timer = timer; ses.meter = meter;
      const tool = (m: Session['mode'], label: string, key: string, title: string) =>
        h('button', { class: ses!.mode === m ? 'on' : '', disabled: ses!.saving, title: `${title} (${key})`, onclick: () => void setMode(m) }, label, h('kbd', {}, key));
      box.append(
        h('button', { disabled: ses.saving, title: paused ? 'Resume (Space)' : 'Pause (Space)', onclick: togglePause }, paused ? 'Resume' : 'Pause'),
        h('span', { class: 'vx-live' }, h('span', { class: `vx-dot${paused ? ' paused' : ''}` }), timer, h('span', { class: 'vx-meter' }, meter)),
        h('div', { class: 'vx-sep' }),
        tool('point', 'Point', 'P', 'Point at elements as you talk about them'),
        tool('draw', 'Draw', 'D', 'Draw on the page; each drawing is saved with a screenshot'),
        h('button', { disabled: ses.saving, title: 'Screenshot of the page now (S)', onclick: () => void shoot({ crop: false }).then(shot => log({ kind: 'shot', t: at(), url: location.href, shot })) }, 'Shot', h('kbd', {}, 'S')),
        tool('browse', 'Browse', 'B', 'Use the app; clicks and page changes are logged'),
        h('div', { class: 'vx-sep' }),
        h('button', { class: 'primary', disabled: ses.saving, title: 'Stop and save the session (Enter)', onclick: () => void end(true) }, ses.saving ? 'Saving…' : 'Finish', h('kbd', {}, '↵')),
        h('button', { class: 'danger', disabled: ses.saving, title: 'Throw the recording away', onclick: () => void end(false) }, ses.armDiscard && Date.now() - ses.armDiscard < 3000 ? 'Discard?' : 'Discard'),
      );
    },
    attached(card) {
      const box = h('div', { class: 'vx-card' }, style(CARD_CSS));
      card.append(box);
      if (!ses) {
        box.append(
          ...(sesErr ? [h('div', { class: 'err' }, sesErr)] : []),
          h('div', {}, 'Talk while you show: everything you point at, draw or screenshot is lined up with what you say, by time.'),
          h('div', { class: 'keys' }, `Space start/pause · P point · D draw · S screenshot · B browse · Enter finish${liveWanted ? '' : ` · transcript by ${serverEngine ?? 'nothing (no engine)'} after you finish`}`));
        return;
      }
      const live = ses.rec.live();
      const said = live.segments.slice(-3).map(s => s.text).join(' ');
      box.append(said || live.interim
        ? h('div', {}, h('span', { class: 'said' }, said), ' ', h('span', { class: 'now' }, live.interim))
        : h('div', { class: 'hint' }, ses.rec.paused() ? 'Paused.' : liveWanted && live.available ? 'Listening…' : `Recording.${serverEngine ? ` ${serverEngine} transcribes it when you finish.` : ''}`));
      if (live.error) box.append(h('div', { class: 'err' }, `Live transcript: ${live.error}`));
      const evs = ses.events.filter(e => e.kind !== 'pause' && e.kind !== 'resume').slice(-4);
      if (evs.length) box.append(h('div', { class: 'evs' }, ...evs.map(e => h('span', { class: 'ev' }, `${clock(e.t / 1000)} ${
        e.kind === 'point' ? short(e.target, e.whole) : e.kind === 'draw' ? 'drawing' : e.kind === 'shot' ? 'screenshot' : e.kind === 'click' ? `clicked ${short(e.target)}` : `went to ${e.url ? new URL(e.url).pathname : ''}`}`))));
      box.append(h('div', { class: 'keys' }, ses.mode === 'point' ? 'Click elements as you talk about them · Esc stops pointing'
        : ses.mode === 'draw' ? 'Draw on the page · Esc stops drawing' : 'Space pause · P point · D draw · S screenshot · Enter finish'));
    },
    onKey(e) {
      const k = e.key.toLowerCase();
      if ((k === ' ' || k === 'enter') && appFocused()) return false;
      if (k === ' ') { togglePause(); return true; }
      if (!ses) return false;
      if (k === 'enter') { void end(true); return true; }
      if (k === 'p') { void setMode(ses.mode === 'point' ? 'browse' : 'point'); return true; }
      if (k === 'd') { void setMode(ses.mode === 'draw' ? 'browse' : 'draw'); return true; }
      if (k === 'b') { void setMode('browse'); return true; }
      if (k === 's') { void shoot({ crop: false }).then(shot => log({ kind: 'shot', t: at(), url: location.href, shot })); return true; }
      return false;
    },
    onEscape() { if (ses?.mode === 'draw') { void setMode('browse'); return true; } return false; },
  });

  rl.addButton({ id: 'voice-session', label: 'Record', key: 'r', title: `Record a review session${cfg.hotkey ? ` (${cfg.hotkey})` : ''}: talk while you point`, onClick: () => bar.show(), active: () => !!ses });

  // Browsing: the app's own clicks and route changes, while recording and not pointing or drawing.
  document.addEventListener('click', e => {
    if (!ses || ses.mode !== 'browse' || ses.rec.paused()) return;
    const el = e.target as Element | null;
    if (!el || !(el instanceof Element) || el.tagName.toLowerCase().startsWith('redline-') || el.closest('[data-redline-voice-ink]')) return;
    log({ kind: 'click', t: at(), url: location.href, target: rl.describe(el, e.clientX, e.clientY) });
  }, true);
  rl.on('page', () => log({ kind: 'nav', t: at(), url: location.href, title: document.title || undefined }));
  rl.on('mode', m => { overlayMode = m; if (ses && ses.mode === 'point' && m !== 'ext:voice-point') { ses.mode = 'browse'; bar.render(); } });
  addEventListener('beforeunload', e => { if (ses && !ses.saving) { e.preventDefault(); e.returnValue = ''; } });
}
