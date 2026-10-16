// Overlay extension (D21) served by UmageAI.Redline.AspNetCore in online mode: a panel section
// where a reviewer creates and revokes personal tokens for the remote MCP endpoint (D35).
// Plain browser JS; the overlay passes the extension API (src/shared/extension.ts).

export default (rl) => {
  const api = (method, path, body) => fetch('/__redline' + path, {
    method, headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: body ? JSON.stringify(body) : undefined,
  }).then(r => { if (!r.ok) throw new Error(r.status + ''); return r.json(); });

  let tokens = null, fresh = null, loading = false;
  const load = () => {
    if (loading) return;
    loading = true;
    api('GET', '/tokens').then(r => { tokens = r.tokens; }).catch(() => { tokens = []; }).finally(() => { loading = false; rl.render(); });
  };
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k === 'style' ? e.setAttribute('style', v) : (e[k] = v);
    e.append(...kids);
    return e;
  };
  const config = (url, token) => JSON.stringify({ mcpServers: { redline: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

  rl.addPanelSection({
    id: 'redline-mcp-tokens',
    title: 'Agent access (MCP)',
    render(root) {
      if (fresh) {
        const pre = el('pre', { style: 'white-space:pre-wrap;word-break:break-all;font-size:11px;user-select:all;margin:6px 0' }, config(fresh.url, fresh.token));
        root.append(el('div', {}, 'New token. Copy it now; it is not shown again. Agent config (Claude Code .mcp.json, Cursor, VS Code):'), pre,
          el('button', { onclick: () => { navigator.clipboard?.writeText(config(fresh.url, fresh.token)); rl.toast('Copied'); } }, 'Copy config'),
          el('button', { onclick: () => { fresh = null; rl.render(); } }, 'Done'));
        return;
      }
      if (tokens === null) { load(); root.append('Loading…'); return; }
      for (const t of tokens) {
        root.append(el('div', { style: 'display:flex;gap:6px;align-items:center;margin:2px 0' },
          el('span', { style: 'flex:1' }, `${t.name || 'token'} · created ${t.created.slice(0, 10)}${t.lastUsed ? ' · used ' + t.lastUsed.slice(0, 10) : ''}`),
          el('button', { onclick: () => api('DELETE', `/tokens/${t.id}`).then(() => { tokens = null; rl.render(); }).catch(() => rl.toast('Could not revoke', true)) }, 'Revoke')));
      }
      root.append(el('button', {
        onclick: () => {
          const name = prompt('Name this token (e.g. "Claude Code on my laptop")') ?? '';
          api('POST', '/tokens', { name }).then(r => { fresh = r; tokens = null; rl.render(); }).catch(() => rl.toast('Could not create a token', true));
        },
      }, 'New token'));
    },
  });
};
