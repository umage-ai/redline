// Dismissible UI for trying Redline on menus that close when you click, focus or press Escape
// outside them. Each one dismisses the way a popular UI kit does, so all of those paths get tested.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Headless UI / Radix style: pointerdown outside (capture), focus moving outside, Escape (capture). */
function useDismiss(refs: RefObject<HTMLElement | null>[], open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const inside = (n: EventTarget | null) => n instanceof Node && refs.some(r => r.current?.contains(n));
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) close(); };
    const onFocus = (e: FocusEvent) => { if (!inside(e.target)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
}

/** A dropdown menu: focuses its first item on open and closes on blur, like a menu button. */
export function ExportMenu() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss([wrap], open, () => setOpen(false));
  useEffect(() => { if (open) menu.current?.querySelector('button')?.focus(); }, [open]);
  return (
    <div className="dropdown" ref={wrap}>
      <button className="ghost" aria-haspopup="menu" aria-expanded={open} data-testid="export" onClick={() => setOpen(o => !o)}>
        Export ▾
      </button>
      {open && (
        <div className="menu" role="menu" ref={menu}
          onBlur={e => { if (!wrap.current?.contains(e.relatedTarget)) setOpen(false); }}>
          <button role="menuitem" onClick={() => setOpen(false)}>Download CSV</button>
          <button role="menuitem" onClick={() => setOpen(false)}>Download PDF report</button>
          <button role="menuitem" onClick={() => setOpen(false)}>Schedule daily email…</button>
        </div>
      )}
    </div>
  );
}

/** Row actions in a portal (fixed position, follows scroll), MUI ClickAwayListener style: click outside. */
export function RowMenu({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect(), w = menu.current?.offsetWidth ?? 190;
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) });
    };
    place();
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <>
      <button ref={btn} className="icon" aria-label={`Actions for ${label}`} aria-haspopup="menu" onClick={() => setOpen(o => !o)}>⋯</button>
      {open && createPortal(
        <div className="menu floating" role="menu" ref={menu} style={pos}>
          <button role="menuitem" onClick={() => setOpen(false)}>Reassign driver</button>
          <button role="menuitem" onClick={() => setOpen(false)}>Message driver</button>
          <button role="menuitem" className="danger" onClick={() => setOpen(false)}>Cancel route {label}</button>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Autocomplete: the suggestion list closes when the input loses focus. */
export function DriverFilter({ drivers, value, onChange }: { drivers: string[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss([wrap], open, () => setOpen(false));
  const hits = drivers.filter(d => d.toLowerCase().includes(value.toLowerCase()));
  return (
    <div className="combo" ref={wrap}>
      <input role="combobox" aria-expanded={open} placeholder="Filter by driver…" value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)} />
      {open && hits.length > 0 && (
        <ul className="menu" role="listbox">
          {hits.map(d => (
            // mousedown: pick before the input's blur closes the list
            <li key={d} role="option" aria-selected={d === value} onMouseDown={e => { e.preventDefault(); onChange(d); setOpen(false); }}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
