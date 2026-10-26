// The hub's one page: sign in, projects, a project's notes (live), its people and tokens, its
// settings. Plain DOM, no build step; note text is reviewer input, so it only ever goes in
// through textContent. Served with a nonce CSP (server.ts).

export const page = (nonce: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redline hub</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header><a class="brand" href="#/"><span class="dot"></span>Redline hub</a><span class="who" id="who"></span></header>
<main id="main"></main>
<dialog id="shot"><img alt="Screenshot"><form method="dialog"><button>Close</button></form></dialog>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;

const CSS = /* css */ `
:root { --ink: #e8173f; --ok: #11845b; --bg: #f6f6f8; --card: #fff; --line: #e1e1e6; --fg: #17171c; --fg-2: #5b5b66; --fg-3: #8a8a95; --soft: #f0f0f3; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --ink: #ff4d6d; --ok: #3ecf8e; --bg: #111114; --card: #1a1a1f; --line: #2e2e36; --fg: #ececf1; --fg-2: #a3a3ad; --fg-3: #6e6e78; --soft: #24242b; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: inherit; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--card); }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; text-decoration: none; }
.dot { width: 12px; height: 12px; border-radius: 6px 6px 6px 2px; background: var(--ink); }
.who { color: var(--fg-2); font-size: 13px; display: flex; gap: 10px; align-items: center; }
main { max-width: 980px; margin: 0 auto; padding: 20px 16px 60px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 24px 0 8px; }
.sub { color: var(--fg-2); margin: 0 0 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 0 0 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.grid .card { margin: 0; text-decoration: none; display: block; }
.grid .card:hover { border-color: var(--fg-3); }
.muted { color: var(--fg-3); font-size: 12.5px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; background: var(--soft); font-size: 12px; color: var(--fg-2); margin-right: 4px; }
.pill.open { background: color-mix(in srgb, var(--ink) 14%, transparent); color: var(--ink); }
.pill.ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
button, .btn { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); padding: 6px 12px; border-radius: 8px; cursor: pointer; text-decoration: none; }
button:hover { border-color: var(--fg-3); }
button.primary { background: var(--ink); border-color: var(--ink); color: #fff; }
button.good { background: var(--ok); border-color: var(--ok); color: #fff; }
button.link { border: 0; background: none; padding: 0; color: var(--fg-2); text-decoration: underline; }
button.danger { color: var(--ink); }
input, textarea, select { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; width: 100%; }
textarea { min-height: 64px; resize: vertical; }
label { display: block; font-size: 13px; color: var(--fg-2); margin: 10px 0 4px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row > input, .row > select { flex: 1; min-width: 160px; width: auto; }
.tabs, .seg { display: flex; gap: 4px; margin: 14px 0; flex-wrap: wrap; }
.tabs a, .seg button { padding: 6px 12px; border-radius: 8px; text-decoration: none; color: var(--fg-2); border: 1px solid transparent; background: none; }
.tabs a.on, .seg button.on { background: var(--card); border-color: var(--line); color: var(--fg); font-weight: 600; }
.note { display: grid; grid-template-columns: 1fr auto; gap: 14px; }
.note.focus { outline: 2px solid var(--ink); }
.note .meta { color: var(--fg-3); font-size: 12.5px; margin-bottom: 6px; }
.note .body { white-space: pre-wrap; word-break: break-word; }
.note .from { color: var(--ink); text-decoration: line-through; white-space: pre-wrap; }
.note .to { color: var(--ok); white-space: pre-wrap; }
.note .reply { margin-top: 8px; padding: 6px 10px; border-left: 3px solid var(--ok); background: var(--soft); border-radius: 0 6px 6px 0; white-space: pre-wrap; }
.note .acts { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
.note .acts textarea { min-height: 38px; flex: 1 1 260px; }
.thumb { width: 180px; max-height: 130px; object-fit: cover; object-position: top left; border-radius: 6px; border: 1px solid var(--line); cursor: zoom-in; background: var(--soft); }
.secret { font: 12.5px ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--soft); border-radius: 8px; padding: 10px 12px; white-space: pre-wrap; word-break: break-all; margin: 6px 0; }
.notice { border-color: var(--ok); }
.error { color: var(--ink); margin: 8px 0; }
.empty { color: var(--fg-3); padding: 24px 0; text-align: center; }
table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); font-size: 13.5px; } th { color: var(--fg-3); font-weight: 500; }
dialog { border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--fg); padding: 10px; max-width: 95vw; }
dialog img { max-width: 90vw; max-height: 80vh; display: block; }
dialog form { text-align: right; margin-top: 8px; }
.login { max-width: 420px; margin: 60px auto; }
.mt { margin-top: 10px; } .mt-s { margin-top: 6px; }
@media (max-width: 640px) { .note { grid-template-columns: 1fr; } .thumb { width: 100%; max-height: 200px; } }
`;

const JS = /* js */ `
const $ = s => document.querySelector(s);
const main = $('#main');
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
async function call(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'x-redline-hub': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { me = null; route(); throw new Error(j.error || 'signed out'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; };
const errBox = () => h('div', { class: 'error', role: 'alert' });
const fail = (box, e) => { box.textContent = e.message; };
let me = null, live = null;

async function boot() {
  // #key=… (the link the CLI prints) signs in once, then leaves the address bar.
  const k = /[#&]key=([^&]+)/.exec(location.hash);
  if (k) { history.replaceState(null, '', location.pathname + '#/'); try { await call('POST', '/login', { key: decodeURIComponent(k[1]) }); } catch {} }
  try { me = await call('GET', '/me'); } catch { me = null; }
  window.addEventListener('hashchange', route);
  route();
}

function header() {
  const w = $('#who'); w.textContent = '';
  if (!me) return;
  w.append(h('span', {}, me.admin ? 'Admin' : me.person), h('span', { class: 'muted' }, 'v' + me.version),
    h('button', { class: 'link', onclick: async () => { await call('POST', '/logout'); me = null; route(); } }, 'Sign out'));
}

function route() {
  if (live) { live.close(); live = null; }
  header();
  main.textContent = '';
  if (!me) return login();
  const m = /^#\\/p\\/([a-z0-9-]+)(?:\\/(n)\\/([a-z0-9]+)|\\/(people|settings))?/.exec(location.hash);
  if (m) return project(m[1], m[4] || 'notes', m[3]);
  if (!me.admin && me.project) { location.hash = '#/p/' + me.project; return; }
  projects();
}

function login() {
  const key = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'rha_… or rht_…', 'aria-label': 'Admin key or member token' });
  const err = errBox();
  main.append(h('div', { class: 'card login' },
    h('h1', {}, 'Sign in'),
    h('p', { class: 'sub' }, 'With the admin key the hub printed when it first started, or with your member token.'),
    h('form', { onsubmit: async e => { e.preventDefault(); try { await call('POST', '/login', { key: key.value.trim() }); me = await call('GET', '/me'); route(); } catch (x) { fail(err, x); } } },
      key, err, h('div', { class: 'row mt' }, h('button', { class: 'primary' }, 'Sign in')))));
  key.focus();
}

async function projects() {
  const { projects } = await call('GET', '/projects');
  main.append(h('h1', {}, 'Projects'), h('p', { class: 'sub' }, 'Each project is one shared set of notes: point a dev server at its store URL with a member token.'));
  main.append(projects.length
    ? h('div', { class: 'grid' }, projects.map(p => h('a', { class: 'card', href: '#/p/' + p.slug },
        h('strong', {}, p.name), h('div', { class: 'muted' }, p.slug),
        h('div', { class: 'mt-s' }, h('span', { class: 'pill open' }, p.open + ' open'), h('span', { class: 'pill ok' }, p.resolved + ' resolved'), h('span', { class: 'pill' }, p.people + ' tokens')))))
    : h('div', { class: 'empty' }, 'No projects yet.'));
  if (!me.admin) return;
  const name = h('input', { placeholder: 'Customer portal', 'aria-label': 'Project name', required: true });
  const sites = h('input', { placeholder: 'Optional: https://staging.example.com http://localhost:5173', 'aria-label': 'Allowed sites' });
  const err = errBox();
  main.append(h('h2', {}, 'New project'), h('form', { class: 'card', onsubmit: async e => {
    e.preventDefault();
    try { const p = await call('POST', '/projects', { name: name.value, sites: sites.value }); location.hash = '#/p/' + p.slug + '/people'; } catch (x) { fail(err, x); }
  } }, h('label', {}, 'Name'), name, h('label', {}, 'Allowed sites (where notes may be filed from; empty: anywhere)'), sites, err,
     h('div', { class: 'row mt' }, h('button', { class: 'primary' }, 'Create project'))));
}

async function project(slug, tab, focus) {
  let p;
  try { p = await call('GET', '/projects/' + slug); } catch (e) { main.append(h('div', { class: 'empty' }, e.message)); return; }
  const tabs = [['notes', 'Notes', ''], ...(me.admin ? [['people', 'People & tokens', '/people'], ['settings', 'Settings', '/settings']] : [])];
  main.append(h('div', { class: 'muted' }, me.admin ? h('a', { href: '#/' }, 'Projects') : null, me.admin ? ' / ' : '', p.slug),
    h('h1', {}, p.name),
    h('div', { class: 'tabs' }, tabs.map(([k, label, path]) => h('a', { href: '#/p/' + slug + path, class: k === tab ? 'on' : '' }, label))));
  const body = h('div');
  main.append(body);
  if (tab === 'people') return people(p, body);
  if (tab === 'settings') return settings(p, body);
  return notes(p, body, focus);
}

async function notes(p, box, focus) {
  let status = focus ? 'all' : (sessionStorage.getItem('status') || 'open');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
  const list = h('div');
  box.append(seg, list);
  const paint = () => {
    seg.textContent = '';
    for (const [k, label] of [['open', 'Open'], ['resolved', 'Resolved'], ['archived', 'Archived'], ['all', 'All']])
      seg.append(h('button', { class: k === status ? 'on' : '', 'aria-pressed': String(k === status), onclick: () => { status = k; try { sessionStorage.setItem('status', k); } catch {} paint(); load(); } }, label));
  };
  const load = async () => {
    const { notes } = await call('GET', '/projects/' + p.slug + '/notes?status=' + status);
    if (list.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;   // don't clobber a reply being typed
    list.textContent = '';
    if (!notes.length) list.append(h('div', { class: 'empty' }, status === 'open' ? 'No open notes. Reviewers file them from the Redline overlay on a dev server pointed at this project.' : 'Nothing here.'));
    for (const n of notes) list.append(card(p, n, load, n.id === focus));
    const f = focus && list.querySelector('.focus'); if (f) { f.scrollIntoView({ block: 'center' }); focus = null; }
  };
  paint(); await load();
  // Live: the same change feed dev servers get, so a note filed on a page shows up here at once.
  live = new EventSource('/api/projects/' + p.slug + '/events');
  live.addEventListener('change', () => { load().catch(() => {}); });
}

function card(p, n, reload, focus) {
  const t = n.target || {};
  const where = n.whole || !n.target ? 'whole page' : [t.tag, t.text ? '“' + t.text.slice(0, 40) + '”' : '', t.source ? t.source.file + (t.source.line ? ':' + t.source.line : '') : ''].filter(Boolean).join(' · ');
  const reply = h('textarea', { placeholder: n.reply ? 'Change the reply' : 'Reply to the reviewer', 'aria-label': 'Reply' });
  const err = errBox();
  const act = async (patch) => { try { await call('PATCH', '/projects/' + p.slug + '/notes/' + n.id, patch); await reload(); } catch (x) { fail(err, x); } };
  const state = n.archived ? h('span', { class: 'pill' }, 'archived') : n.done ? h('span', { class: 'pill ok' }, n.seen ? 'resolved · seen' : 'resolved') : h('span', { class: 'pill open' }, 'open');
  const shot = n.screenshot ? '/api/projects/' + p.slug + '/assets/' + n.screenshot.split('/').pop() : null;
  return h('div', { class: 'card note' + (focus ? ' focus' : ''), id: 'n-' + n.id },
    h('div', {},
      h('div', { class: 'meta' }, state, ' ', n.type, ' on ', h('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer' }, n.page), ' · ', where),
      n.type === 'text' ? [h('div', { class: 'from' }, n.from || ''), h('div', { class: 'to' }, n.to || '')] : null,
      n.body ? h('div', { class: 'body' }, n.body) : null,
      n.reply ? h('div', { class: 'reply' }, n.reply) : null,
      h('div', { class: 'muted mt-s' }, [n.author || 'anonymous', ago(n.created), n.app ? 'app ' + n.app : '', n.build ? 'build ' + n.build : ''].filter(Boolean).join(' · ')),
      h('div', { class: 'acts' }, reply,
        h('button', { onclick: () => reply.value.trim() && act({ reply: reply.value }) }, 'Reply'),
        n.done ? h('button', { onclick: () => act({ done: false }) }, 'Reopen') : h('button', { class: 'good', onclick: () => act({ done: true, ...(reply.value.trim() ? { reply: reply.value } : {}) }) }, 'Resolve'),
        h('button', { onclick: () => act({ archived: !n.archived }) }, n.archived ? 'Unarchive' : 'Archive'),
        h('button', { class: 'danger', onclick: async () => { if (confirm('Delete this note for everyone?')) { try { await call('DELETE', '/projects/' + p.slug + '/notes/' + n.id); await reload(); } catch (x) { fail(err, x); } } } }, 'Delete')),
      err),
    shot ? h('img', { class: 'thumb', src: shot, alt: 'Screenshot of the note', loading: 'lazy', onclick: () => { const d = $('#shot'); d.querySelector('img').src = shot; d.showModal(); } }) : h('span'));
}

async function people(p, box) {
  const { tokens } = await call('GET', '/projects/' + p.slug + '/tokens');
  const person = h('input', { placeholder: 'alice@example.com', 'aria-label': 'Person or agent', required: true });
  const kind = h('select', { 'aria-label': 'Kind' }, h('option', { value: 'member' }, 'Person (dev server + UI)'), h('option', { value: 'agent' }, 'Agent (MCP only)'));
  const err = errBox();
  const out = h('div');
  box.append(h('p', { class: 'sub' }, 'A token acts as one person: their notes carry their name, and only they see their resolved notes go green. Tokens are shown once; the hub keeps only a hash.'),
    h('form', { class: 'card', onsubmit: async e => {
      e.preventDefault();
      try { const t = await call('POST', '/projects/' + p.slug + '/tokens', { person: person.value, kind: kind.value }); person.value = ''; await people(p, (box.textContent = '', box)); box.prepend(issued(t)); } catch (x) { fail(err, x); }
    } }, h('div', { class: 'row' }, person, kind, h('button', { class: 'primary' }, 'New token')), err), out);
  out.append(tokens.length ? h('table', {}, h('tr', {}, h('th', {}, 'Who'), h('th', {}, 'Kind'), h('th', {}, 'Created'), h('th', {}, 'Last used'), h('th', {})),
    tokens.map(t => h('tr', {}, h('td', {}, t.person), h('td', {}, t.kind), h('td', {}, ago(t.created)), h('td', {}, t.used ? ago(t.used) : 'never'),
      h('td', {}, h('button', { class: 'link', onclick: async () => { if (confirm('Revoke the token for ' + t.person + '? Their dev server and agents stop working until they get a new one.')) { await call('DELETE', '/projects/' + p.slug + '/tokens/' + t.id); box.textContent = ''; people(p, box); } } }, 'Revoke')))))
    : h('div', { class: 'empty' }, 'No tokens yet. Add one per reviewer, and one per agent.'));
}

function issued(t) {
  const env = 'REDLINE_STORE_URL=' + t.store + '\\nREDLINE_STORE_TOKEN=' + t.token;
  const mcp = 'claude mcp add --transport http redline-' + t.store.split('/').pop() + ' ' + t.mcp + ' --header "Authorization: Bearer ' + t.token + '"';
  const json = JSON.stringify({ mcpServers: { redline: { type: 'http', url: t.mcp, headers: { Authorization: 'Bearer ' + t.token } } } }, null, 2);
  const copy = text => h('button', { onclick: e => { navigator.clipboard.writeText(text).then(() => { e.target.textContent = 'Copied'; }); } }, 'Copy');
  return h('div', { class: 'card notice', role: 'status' },
    h('strong', {}, 'Token for ' + t.person + '. Copy it now: it is not shown again.'),
    t.kind === 'member' ? [h('label', {}, 'Dev server environment (the Redline plugin picks these up)'), h('div', { class: 'secret' }, env), copy(env)] : null,
    h('label', {}, 'MCP for an agent (Claude Code)'), h('div', { class: 'secret' }, mcp), copy(mcp),
    h('label', {}, 'MCP config (other agents)'), h('div', { class: 'secret' }, json), copy(json));
}

function settings(p, box) {
  const name = h('input', { value: p.name, 'aria-label': 'Name' });
  const sites = h('textarea', { 'aria-label': 'Allowed sites' }); sites.value = p.sites.join('\\n');
  const err = errBox(), ok = h('span', { class: 'muted', role: 'status' });
  box.append(
    h('div', { class: 'card' }, h('label', {}, 'Store URL (REDLINE_STORE_URL)'), h('div', { class: 'secret' }, p.store), h('label', {}, 'MCP endpoint'), h('div', { class: 'secret' }, p.mcp)),
    h('form', { class: 'card', onsubmit: async e => { e.preventDefault(); try { await call('PATCH', '/projects/' + p.slug, { name: name.value, sites: sites.value }); ok.textContent = 'Saved.'; } catch (x) { fail(err, x); } } },
      h('label', {}, 'Name'), name,
      h('label', {}, 'Allowed sites, one per line: notes filed from any other page are refused. Empty: any site. https://*.example.com matches subdomains.'), sites,
      h('p', { class: 'muted' }, 'A guard against filing from the wrong place (production with real customer data, say), not access control: tokens decide who gets in.'),
      err, h('div', { class: 'row' }, h('button', { class: 'primary' }, 'Save'), ok)),
    h('div', { class: 'card' }, h('strong', {}, 'Delete project'), h('p', { class: 'muted' }, 'Removes its notes, screenshots and tokens.'),
      h('button', { class: 'danger', onclick: async () => { if (prompt('Type ' + p.slug + ' to delete the project and all its notes.') === p.slug) { await call('DELETE', '/projects/' + p.slug); location.hash = '#/'; } } }, 'Delete project')));
}

boot();
`;
