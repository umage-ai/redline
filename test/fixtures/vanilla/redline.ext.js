// A fixture overlay extension (D21): a toolbar button with a key, a panel section, events.
export default (rl) => {
  const w = window;
  w.extEvents = [];
  rl.addButton({
    id: 'ping', label: 'Ping', key: 'p', title: 'Fixture button',
    onClick: () => { w.pinged = (w.pinged || 0) + 1; rl.toast('pong'); rl.render(); },
    active: () => (w.pinged || 0) > 0,
  });
  rl.addPanelSection({ id: 'fixture', title: 'Fixture', render: el => { el.textContent = `Hello from an extension · ${rl.notes().length} notes`; } });
  for (const e of ['open', 'close', 'mode', 'noteCreated', 'sourceWritten']) rl.on(e, (arg) => w.extEvents.push(e === 'mode' ? `mode:${arg}` : e));
};
