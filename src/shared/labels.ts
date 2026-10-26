// Note labels (D46): an optional tag on a note (Bug, UX, …), picked from chips in the popover.
// The label's name is what a note stores and what its markdown heading shows.

export interface LabelDef {
  name: string;
  color?: string;           // any CSS colour; the chip's dot and the card's tag
}

/** The `labels` option: names, or names with a colour; false turns labels off. */
export type LabelsOption = (string | LabelDef)[] | false;

/**
 * A list, or a function asked on every /config request (the overlay loads it once per page load), e.g. to read
 * labels from a backend or per reviewer. `req` is the incoming request (Node: an IncomingMessage).
 */
export type LabelsSource<Req = unknown> = LabelsOption | ((ctx: { req: Req }) => LabelsOption | Promise<LabelsOption>);

export const DEFAULT_LABELS: LabelDef[] = [
  { name: 'Bug', color: '#ff5c5c' },
  { name: 'UX', color: '#b48cff' },
  { name: 'Idea', color: '#ffcc4d' },
  { name: 'Copy', color: '#5cb8ff' },
];

/** A label as stored: one line, trimmed, at most 30 characters; '' when there is none. */
export function cleanLabel(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 30).trim() : '';
}

/** The option as the overlay gets it from /config: unset → the defaults, false → none; names cleaned, duplicates dropped. */
export function normalizeLabels(opt: LabelsOption | undefined): LabelDef[] {
  if (opt === false) return [];
  const out: LabelDef[] = [];
  for (const l of opt ?? DEFAULT_LABELS) {
    const name = cleanLabel(typeof l === 'string' ? l : l?.name);
    if (!name || out.some(o => o.name.toLowerCase() === name.toLowerCase())) continue;
    const color = typeof l === 'object' && typeof l.color === 'string' && l.color.trim() ? l.color.trim() : undefined;
    out.push(color ? { name, color } : { name });
  }
  return out;
}
