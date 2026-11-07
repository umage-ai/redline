import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS, translator } from '../../src/client/strings.ts';

test('strings: overrides win in order, placeholders fill, unknown ones stay (D50)', () => {
  const t = translator({ saved: 'Gemt → {file}', notes: 'Noter' }, { notes: 'Notizen', comment: 42 as unknown as string });
  assert.equal(t('saved', { file: '.redline/pages/x.md' }), 'Gemt → .redline/pages/x.md');
  assert.equal(t('notes'), 'Notizen');                       // the later override wins
  assert.equal(t('comment'), STRINGS.comment);                // a non-string is ignored
  assert.equal(t('thisPage', {}), 'This page ({n})');         // no value: the placeholder stays
  assert.equal(t('promptPage', { file: 'a.md', n: 2, how: 'Use {guide}.' }), 'Apply the open Redline notes in a.md (2 open). Use {guide}.');   // values aren't re-filled
});

test('strings: every placeholder is a plain {word}', () => {
  for (const [k, v] of Object.entries(STRINGS)) {
    assert.equal(typeof v, 'string', k);
    for (const m of v.match(/\{[^}]*\}/g) ?? []) assert.match(m, /^\{\w+\}$/, `${k}: ${m}`);
  }
});
