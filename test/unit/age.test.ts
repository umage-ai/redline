import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, relativeAge } from '../../src/shared/age.ts';

const now = new Date(2026, 9, 15, 12, 0); // 2026-10-15 12:00 local, like the server's stamp

test('relativeAge buckets the note stamp', () => {
  const cases: [string, string][] = [
    ['2026-10-15 12:00', 'just now'],
    ['2026-10-15 11:55', '5 min ago'],
    ['2026-10-15 09:00', '3 h ago'],
    ['2026-10-14 12:00', '1 day ago'],
    ['2026-10-05 12:00', '10 days ago'],
    ['2026-09-24 12:00', '3 weeks ago'],
    ['2026-06-15 12:00', '4 months ago'],
    ['2025-10-15 12:00', '1 year ago'],
    ['2026-10-15 12:30', 'just now'], // clock skew: never negative
  ];
  for (const [at, want] of cases) assert.equal(relativeAge(at, now), want, at);
  assert.equal(relativeAge('yesterday', now), null);
});

test('notes go stale after 14 days', () => {
  assert.equal(isStale('2026-10-02 12:00', now), false);
  assert.equal(isStale('2026-10-01 12:00', now), true);
  assert.equal(isStale('garbage', now), false);
});
