// The launcherPosition option: a side or the middle on each axis, px from the edge (src/shared/place.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launcherPlace, launcherVars } from '../../src/shared/place.ts';

test('launcherPosition: strings, offsets and the object form; anything unreadable falls back to bottom right', () => {
  assert.deepEqual(launcherPlace(undefined), { x: 'right', y: 'bottom', offsetX: 16, offsetY: 16 });
  assert.deepEqual(launcherPlace('bottom-left'), { x: 'left', y: 'bottom', offsetX: 16, offsetY: 16 });
  assert.deepEqual(launcherPlace('Top-Right 24'), { x: 'right', y: 'top', offsetX: 24, offsetY: 24 });
  assert.deepEqual(launcherPlace('left-middle 8 0'), { x: 'left', y: 'middle', offsetX: 8, offsetY: 0 }, 'either order; 0 is a distance');
  assert.deepEqual(launcherPlace('bottom-center 16 80'), { x: 'center', y: 'bottom', offsetX: 16, offsetY: 80 });
  assert.deepEqual(launcherPlace({ y: 'top', offsetY: 70 }), { x: 'right', y: 'top', offsetX: 16, offsetY: 70 });
  assert.deepEqual(launcherPlace('sideways -5'), { x: 'right', y: 'bottom', offsetX: 16, offsetY: 16 }, 'unknown words and negatives are ignored');
  assert.deepEqual(launcherPlace({ x: 'up' as never, offsetX: Number.NaN }), { x: 'right', y: 'bottom', offsetX: 16, offsetY: 16 });
});

test('launcherPosition: CSS variables, safe-area aware, centred by a translate', () => {
  const v = launcherVars(launcherPlace('top-left 24'));
  assert.equal(v['--l-left'], 'max(24px, env(safe-area-inset-left))');
  assert.equal(v['--l-top'], 'max(24px, env(safe-area-inset-top))');
  assert.equal(v['--l-right'], 'auto');
  assert.equal(v['--l-shift'], 'translate(0, 0)');
  const c = launcherVars(launcherPlace('middle-center'));
  assert.deepEqual([c['--l-left'], c['--l-top'], c['--l-shift']], ['50%', '50%', 'translate(-50%, -50%)']);
});
