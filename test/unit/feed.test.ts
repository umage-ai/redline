// gatedFeed (D72): a long-lived stream is held only while wanted and the tab is visible, let go a grace
// period after either ends, reopened on return with a catch-up; the stall check closes it and warns once
// when a plain request can't reach the server either (the browser's connections are used up).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatedFeed } from '../../src/client/feed.ts';

// A document whose visibility the test sets.
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as 'visible' | 'hidden' });
(globalThis as { document?: unknown }).document = doc;
const show = (v: 'visible' | 'hidden') => { doc.visibilityState = v; doc.dispatchEvent(new Event('visibilitychange')); };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Waits until `ok()` holds (at most 2 s): timers run late when the machine is busy. */
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await wait(10); };

/** A fake stream: counts opens and closes, connects at once unless told not to. */
function fake(connects = true) {
  const s = { opens: 0, closes: 0, open: (up: (on: boolean) => void) => { s.opens++; if (connects) queueMicrotask(() => up(true)); return () => { s.closes++; }; } };
  return s;
}

test('opens while visible; hidden past the grace closes it; shown again reopens with a catch-up', async () => {
  show('visible');
  const s = fake();
  let resumed = 0;
  const f = gatedFeed({ open: s.open, graceMs: 30, resumed: () => resumed++ });
  assert.equal(s.opens, 1);
  assert.equal(resumed, 0);
  show('hidden');
  await wait(10);
  show('visible');                                   // back within the grace: kept
  await wait(40);
  assert.deepEqual([s.opens, s.closes], [1, 0]);
  show('hidden');
  await until(() => s.closes === 1);
  assert.deepEqual([s.opens, s.closes], [1, 1]);
  assert.equal(f.opened, false);
  show('visible');
  assert.deepEqual([s.opens, resumed], [2, 1]);
  f.stop();
  assert.equal(s.closes, 2);
});

test('want: closed a grace period after it stops being wanted, reopened on update', async () => {
  show('visible');
  const s = fake();
  let wanted = false;
  const f = gatedFeed({ open: s.open, graceMs: 20, want: () => wanted });
  assert.equal(s.opens, 0);
  wanted = true; f.update();
  assert.equal(s.opens, 1);
  wanted = false; f.update();
  await until(() => s.closes === 1);
  assert.equal(s.closes, 1);
  f.stop();
});

test('stall: not connected and the probe gets no answer either → warned once, closed until shown again', async () => {
  show('visible');
  const s = fake(false);
  let stalled = 0;
  const f = gatedFeed({ open: s.open, stall: { probe: () => new Promise(() => {}), ms: 20, stalled: () => stalled++ } });
  await until(() => stalled === 1);
  assert.equal(stalled, 1);
  assert.deepEqual([s.opens, s.closes], [1, 1]);
  f.update();                                        // blocked: not reopened by an update
  assert.equal(s.opens, 1);
  show('hidden'); show('visible');                   // the reviewer comes back (closed some tabs): tried again
  assert.equal(s.opens, 2);
  await wait(60);
  assert.equal(stalled, 1);                          // the toast once per page
  f.stop();
});

test('stall: a connected stream whose probe stalls (it took the last connection) lets go too', async () => {
  show('visible');
  const s = fake(true);
  let stalled = 0;
  const f = gatedFeed({ open: s.open, stall: { probe: () => new Promise(() => {}), ms: 20, stalled: () => stalled++ } });
  await until(() => stalled === 1);
  assert.deepEqual([stalled, s.closes], [1, 1]);
  f.stop();
});

test('stall: a probe that answers is no stall, connected or not', async () => {
  show('visible');
  for (const connects of [true, false]) {
    const s = fake(connects);
    let stalled = 0;
    const f = gatedFeed({ open: s.open, stall: { probe: async () => ({}), ms: 20, stalled: () => stalled++ } });
    await wait(60);
    assert.deepEqual([stalled, s.closes], [0, 0]);
    f.stop();
  }
});
