// All overlay CSS lives in the shadow root, so it can't leak into or be broken by the app.
export const CSS = /* css */ `
:host { all: initial; }
* { box-sizing: border-box; }
.rl {
  --ink: #ff2d55; --ink-2: #ff6b85; --bg: #131316; --bg-2: #1c1c21; --bg-3: #26262d;
  --line: #34343c; --fg: #ececf1; --fg-2: #a3a3ad; --fg-3: #6e6e78; --ok: #3ecf8e;
  font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--fg); -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
kbd { font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; padding: 1px 4px; border-radius: 4px; background: var(--bg-3); color: var(--fg-2); }

/* launcher */
.launcher {
  position: fixed; right: 16px; bottom: 16px; width: 36px; height: 36px; border-radius: 50%;
  background: var(--bg); border: 1px solid var(--line); display: grid; place-items: center;
  box-shadow: 0 4px 16px rgba(0,0,0,.3); opacity: .7; transition: opacity .15s, transform .15s; pointer-events: auto;
}
.launcher:hover { opacity: 1; transform: scale(1.06); }
.launcher svg { width: 18px; height: 18px; }
.badge { position: absolute; top: -4px; right: -4px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px;
  background: var(--ink); color: #fff; font-size: 10.5px; font-weight: 700; display: grid; place-items: center; }

/* toolbar */
.bar {
  position: fixed; left: 50%; bottom: calc(16px + var(--lift, 0px)); transform: translateX(-50%); display: flex; align-items: center; gap: 2px;
  padding: 4px; border-radius: 12px; background: var(--bg); border: 1px solid var(--line);
  box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; white-space: nowrap;
}
.bar .brand { display: flex; align-items: center; gap: 6px; padding: 0 10px 0 8px; font-weight: 650; letter-spacing: .01em; }
.bar .brand svg { width: 15px; height: 15px; }
.bar .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
.bar button { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; color: var(--fg-2); }
.bar button:hover { background: var(--bg-3); color: var(--fg); }
.bar button.on { background: var(--ink); color: #fff; }
.bar button.on kbd { background: rgba(255,255,255,.2); color: #fff; }
.bar .count { background: var(--bg-3); color: var(--fg); border-radius: 9px; padding: 0 6px; font-size: 11px; font-weight: 650; }
.bar button.on .count { background: rgba(255,255,255,.25); }

/* hover highlight */
.hl { position: fixed; pointer-events: none; border: 2px solid var(--ink); border-radius: 3px; background: rgba(255,45,85,.07);
  box-shadow: 0 0 0 1px rgba(255,255,255,.5); transition: all .05s; }
.hl.text { border-style: dashed; }
.hl-label { position: fixed; pointer-events: none; padding: 2px 7px; border-radius: 5px; background: var(--ink); color: #fff;
  font: 600 11px ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }

/* pins */
.pin { position: fixed; width: 24px; height: 24px; margin: -24px 0 0 -2px; border-radius: 12px 12px 12px 2px;
  background: var(--ink); color: #fff; font-size: 11px; font-weight: 750; display: grid; place-items: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.35), 0 0 0 2px #fff; pointer-events: auto; cursor: pointer; transition: transform .12s; }
.pin:hover { transform: scale(1.15); }
.pin.done { background: #6e6e78; }
.pin.text::after { content: 'T'; position: absolute; right: -7px; bottom: -6px; font-size: 9px; background: #fff; color: var(--ink); border-radius: 4px; padding: 0 3px; }
.pin.sketch::after { content: '✎'; position: absolute; right: -7px; bottom: -6px; font-size: 9px; background: #fff; color: var(--ink); border-radius: 4px; padding: 0 3px; }
.tip { position: fixed; max-width: 300px; padding: 8px 10px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line);
  box-shadow: 0 8px 24px rgba(0,0,0,.35); pointer-events: none; font-size: 12.5px; white-space: pre-wrap; }
.tip .re { margin-top: 6px; padding-left: 8px; border-left: 2px solid var(--ok); color: var(--fg-2); }

/* popover */
.pop { position: fixed; width: min(360px, calc(100vw - 16px)); border-radius: 12px; background: var(--bg); border: 1px solid var(--line);
  box-shadow: 0 16px 48px rgba(0,0,0,.45); pointer-events: auto; overflow: hidden; }
.pop header { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: var(--bg-2); border-bottom: 1px solid var(--line); }
.pop header .what { flex: 1; min-width: 0; font: 600 11.5px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop header button { padding: 2px 7px; border-radius: 6px; color: var(--fg-2); font-size: 12px; }
.pop header button:hover { background: var(--bg-3); color: var(--fg); }
.pop textarea { display: block; width: 100%; min-height: 92px; max-height: 300px; resize: vertical; padding: 10px 12px; border: 0; outline: 0;
  background: transparent; color: var(--fg); font: inherit; font-size: 13.5px; }
.pop textarea::placeholder { color: var(--fg-3); }
.pop .diff { margin: 10px 12px 0; padding: 8px 10px; border-radius: 8px; background: var(--bg-2); font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; max-height: 140px; overflow: auto; }
.pop .diff .del { color: #ff8a9d; text-decoration: line-through; }
.pop .diff .ins { color: #7ee2b0; }
.pop footer { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--line); }
.pop footer label { display: flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: 12px; cursor: pointer; }
.pop footer .grow { flex: 1; }
.btn { padding: 6px 12px; border-radius: 8px; background: var(--bg-3); color: var(--fg); font-weight: 550; }
.btn:hover { background: #31313a; }
.btn.primary { background: var(--ink); color: #fff; }
.btn.primary:hover { background: #ff4468; }
.btn:disabled { opacity: .5; cursor: default; }

/* sketch */
.rl-sketch { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: auto; cursor: crosshair; touch-action: none; }
.rl-sketch-input { position: fixed; min-width: 160px; padding: 4px 8px; border-radius: 6px; border: 2px solid var(--ink); outline: 0;
  background: #fff; color: #111; font: 600 16px system-ui, sans-serif; pointer-events: auto; }
.tools { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); display: flex; flex-wrap: wrap; justify-content: center; gap: 2px; white-space: nowrap; width: max-content; max-width: calc(100vw - 16px); padding: 4px; border-radius: 12px;
  background: var(--bg); border: 1px solid var(--line); box-shadow: 0 8px 30px rgba(0,0,0,.35); pointer-events: auto; }
.tools button { padding: 6px 10px; border-radius: 8px; color: var(--fg-2); display: flex; gap: 6px; align-items: center; }
.tools button:hover { background: var(--bg-3); color: var(--fg); }
.tools button.on { background: var(--bg-3); color: var(--fg); box-shadow: inset 0 0 0 1px var(--ink); }
.tools button.done { background: var(--ink); color: #fff; }
/* colour: one swatch; the palette folds out under it */
.tools .colors { position: relative; display: flex; align-items: center; padding: 0 8px; margin: 0 2px; border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
.tools button.sw { width: 20px; height: 20px; min-height: 0; padding: 0; border-radius: 50%; background: var(--c); box-shadow: inset 0 0 0 1px rgba(255,255,255,.3); transition: transform .1s; }
.tools button.sw:hover { background: var(--c); transform: scale(1.12); }
.tools button.sw.current[aria-expanded="true"], .tools .palette button.sw.on { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--fg); }
.tools .palette { position: absolute; top: calc(100% + 10px); left: 50%; transform: translateX(-50%); display: flex; gap: 8px; padding: 8px 10px;
  border-radius: 12px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(0,0,0,.35); animation: rl-fold .14s ease-out; }
@keyframes rl-fold { from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(.92); } }

/* text edit */
.ed { position: fixed; outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 2px; pointer-events: auto; white-space: pre-wrap;
  overflow-wrap: break-word; caret-color: var(--ink); z-index: 1; }

/* panel */
.panel { position: fixed; top: 0; right: 0; bottom: 0; width: 380px; display: flex; flex-direction: column; background: var(--bg);
  border-left: 1px solid var(--line); box-shadow: -12px 0 40px rgba(0,0,0,.3); pointer-events: auto; }
.panel > header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.panel > header h2 { margin: 0; flex: 1; font-size: 14px; font-weight: 700; }
.panel > header button { padding: 4px 8px; border-radius: 6px; color: var(--fg-2); }
.panel > header button:hover { background: var(--bg-3); color: var(--fg); }
.filters { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--line); color: var(--fg-2); font-size: 12px; }
.seg { display: flex; background: var(--bg-2); border-radius: 8px; padding: 2px; }
.seg button { padding: 3px 9px; border-radius: 6px; color: var(--fg-2); font-size: 12px; }
.seg button.on { background: var(--bg-3); color: var(--fg); }
.filters label { margin-left: auto; display: flex; gap: 5px; align-items: center; cursor: pointer; }
.list { flex: 1; overflow: auto; padding: 8px 10px 16px; }
.group { margin: 12px 4px 6px; color: var(--fg-3); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; }
.empty { padding: 32px 16px; text-align: center; color: var(--fg-3); }
.card { position: relative; margin: 6px 0; padding: 10px 12px; border-radius: 10px; background: var(--bg-2); border: 1px solid transparent; }
.card:hover { border-color: var(--line); }
.card.focus { border-color: var(--ink); }
.card.done { opacity: .6; }
.card .top { display: flex; align-items: center; gap: 8px; }
.card .num { width: 20px; height: 20px; flex: none; border-radius: 10px 10px 10px 2px; background: var(--ink); color: #fff; font-size: 10.5px; font-weight: 750; display: grid; place-items: center; }
.card.done .num { background: #6e6e78; }
.card .loc { flex: 1; min-width: 0; font: 11.5px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .acts { display: flex; gap: 2px; opacity: 0; transition: opacity .1s; }
.card:hover .acts, .card.focus .acts { opacity: 1; }
.card .acts button { padding: 2px 6px; border-radius: 5px; color: var(--fg-2); font-size: 12px; }
.card .acts button:hover { background: var(--bg-3); color: var(--fg); }
.card .body { margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.card .body.muted { color: var(--fg-3); font-style: italic; }
.card .diff { margin-top: 6px; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; }
.card .diff .del { color: #ff8a9d; text-decoration: line-through; }
.card .diff .ins { color: #7ee2b0; }
.card img { display: block; margin-top: 8px; max-width: 100%; max-height: 140px; border-radius: 6px; border: 1px solid var(--line); cursor: zoom-in; }
.card .reply { margin-top: 8px; padding: 6px 9px; border-left: 2px solid var(--ok); background: rgba(62,207,142,.07); border-radius: 0 6px 6px 0; color: var(--fg); white-space: pre-wrap; }
.card .reply::before { content: 'Agent'; display: block; font-size: 10.5px; font-weight: 700; color: var(--ok); text-transform: uppercase; letter-spacing: .05em; }
.card .meta { margin-top: 6px; color: var(--fg-3); font-size: 11px; }
.card textarea { width: 100%; min-height: 70px; margin-top: 6px; padding: 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; resize: vertical; outline: 0; }
.panel > footer { padding: 10px 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.panel > footer .file { color: var(--fg-3); font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.panel > footer .row { display: flex; gap: 8px; align-items: center; }
.panel > footer label { color: var(--fg-2); font-size: 12px; display: flex; gap: 6px; align-items: center; cursor: pointer; }

/* zoomed image */
.zoom { position: fixed; inset: 0; background: rgba(0,0,0,.8); display: grid; place-items: center; pointer-events: auto; cursor: zoom-out; }
.zoom img { max-width: 92vw; max-height: 92vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.6); }

/* toast */
.toast { position: fixed; left: 50%; bottom: calc(64px + var(--lift, 0px)); transform: translateX(-50%); padding: 8px 14px; border-radius: 9px; background: var(--bg);
  border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(0,0,0,.35); pointer-events: none; font-size: 12.5px; }
.toast.err { border-color: var(--ink); color: #ffb3c0; }
.busy { position: fixed; inset: 0; cursor: progress; pointer-events: auto; }

/* touch: bigger targets, no keyboard hints, actions always visible */
@media (pointer: coarse) {
  .launcher { width: 44px; height: 44px; }
  .launcher svg { width: 22px; height: 22px; }
  .bar kbd, .tools kbd { display: none; }
  .bar button, .tools button { min-height: 40px; padding: 6px 12px; }
  .tools button.sw { width: 30px; height: 30px; min-height: 0; padding: 0; }
  .tools .palette { gap: 10px; padding: 10px 12px; }
  .toast { bottom: calc(76px + var(--lift, 0px)); }
  .pin { width: 28px; height: 28px; margin-top: -28px; border-radius: 14px 14px 14px 2px; font-size: 12px; }
  .pop header button { padding: 6px 10px; }
  .pop textarea, .card textarea { font-size: 16px; }
  .btn { padding: 9px 14px; }
  .card .acts { opacity: 1; }
  .card .acts button { padding: 6px 9px; font-size: 14px; }
  .seg button { padding: 7px 10px; }
  .pop footer input, .filters input, .panel > footer input { width: 18px; height: 18px; }
}
@media (hover: none) { .card .acts { opacity: 1; } }

/* phones: fit everything inside the viewport */
@media (max-width: 560px) {
  .launcher { right: max(12px, env(safe-area-inset-right)); bottom: max(12px, env(safe-area-inset-bottom)); }
  .bar { bottom: calc(max(12px, env(safe-area-inset-bottom)) + var(--lift, 0px)); max-width: calc(100vw - 16px); overflow-x: auto; scrollbar-width: none; }
  .bar .brand span, .bar .brand + .sep { display: none; }
  .bar .brand { padding: 0 6px; }
  .bar button { padding: 6px 9px; }
  .toast { max-width: calc(100vw - 24px); white-space: normal; text-align: center; overflow-wrap: anywhere; }
  .tools { top: max(8px, env(safe-area-inset-top)); }
  .tools button { padding: 6px 9px; }
  .pop { width: calc(100vw - 16px); }
  .pop textarea { max-height: 30vh; }
  .panel { width: 100vw; border-left: 0; }
  .filters { flex-wrap: wrap; }
  .tip { max-width: calc(100vw - 16px); }
  .rl-sketch-input { max-width: calc(100vw - 8px); }
}
`;
