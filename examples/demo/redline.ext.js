// A demo overlay extension (D21): what a host app can add to Redline's toolbar and panel.
// Loaded by examples/demo/vite.config.mjs through `extensions: ['redline.ext.js']`.
export default (rl) => {
  // A toolbar button with a key: copies this page's open notes as a checklist.
  rl.addButton({
    id: 'copy', label: 'Copy list', key: 'l', title: "Copy this page's open notes as a checklist",
    onClick: async () => {
      const open = rl.notes().filter(n => !n.done);
      const text = open.map(n => `- [ ] ${(n.type === 'text' ? `"${n.from}" → "${n.to}"` : n.body).split('\n')[0]}`).join('\n');
      try { await navigator.clipboard.writeText(text || '(no open notes)'); rl.toast(`Copied ${open.length} note${open.length === 1 ? '' : 's'}`); }
      catch { rl.toast('Clipboard blocked'); }
    },
  });

  // A panel section: a small review summary that re-renders with the notes.
  rl.addPanelSection({
    id: 'summary', title: 'Review summary',
    render: el => {
      const all = rl.notes(), open = all.filter(n => !n.done);
      const by = t => open.filter(n => n.type === t).length;
      el.textContent = `${open.length} open (${by('comment')} comments, ${by('text')} text, ${by('sketch')} sketches) · ${all.length - open.length} done`;
    },
  });

  // Events: react to what the reviewer does.
  rl.on('noteCreated', () => rl.render());
  rl.on('sourceWritten', r => rl.toast(`Wrote ${r.file}:${r.line}`));

  // A button that only exists while the panel is open (API v2: removeButton, panel events).
  rl.on('panel', ({ open }) => {
    if (open) rl.addButton({ id: 'hint', label: 'Tip', title: 'Text mode + "Apply to file" edits the JSX directly', onClick: () => { rl.setMode('text'); rl.toast('Click any static text, edit it, then Apply to file'); } });
    else rl.removeButton('hint');
  });
};
