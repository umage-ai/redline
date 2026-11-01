/** Whitespace collapsed to single spaces and cut to `n` characters, ending in an ellipsis when cut. */
export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
