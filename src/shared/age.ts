// Relative age of a note's `at` stamp ('YYYY-MM-DD HH:MM', the dev server's local time).

export const STALE_DAYS = 14;

/** Minutes since `at`, or null if it doesn't parse. */
export function ageMinutes(at: string, now = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Math.max(0, Math.floor((now.getTime() - t.getTime()) / 60000));
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", "3 weeks ago", "4 months ago", "1 year ago". */
export function relativeAge(at: string, now = new Date()): string | null {
  const min = ageMinutes(at, now);
  if (min === null) return null;
  const n = (v: number, unit: string) => `${v} ${unit}${v === 1 ? '' : 's'} ago`;
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return n(d, 'day');
  if (d < 60) return n(Math.floor(d / 7), 'week');
  if (d < 365) return n(Math.floor(d / 30), 'month');
  return n(Math.floor(d / 365), 'year');
}

/** Open notes older than STALE_DAYS may point at UI that has since changed. */
export function isStale(at: string, now = new Date()): boolean {
  const min = ageMinutes(at, now);
  return min !== null && min >= STALE_DAYS * 24 * 60;
}
