// Golden fixtures shared with the .NET port (dotnet/tests, GoldenTests.cs): both
// implementations must produce these bytes, so the markdown format can't drift between them.
// Regenerate the expected files after an intended format change: UPDATE_GOLDEN=1 npm run test:unit
// (then check the diff, and make the C# tests pass against it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageFile, pageSlug, parsePage, serializeIndex, serializePage } from '../../src/server/format.ts';
import type { Note } from '../../src/shared/types.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../golden');
const update = process.env.UPDATE_GOLDEN === '1';
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
const files = (sub: string, ext: string) => readdirSync(path.join(dir, sub)).filter(f => f.endsWith(ext) && !f.endsWith('.out.md')).sort();

/** Compare with the expected file, or write it under UPDATE_GOLDEN=1. */
function expectFile(rel: string, actual: string) {
  if (update) { writeFileSync(path.join(dir, rel), actual); return; }
  assert.equal(actual, read(rel), `${rel} differs`);
}

for (const f of files('pages', '.json')) {
  test(`golden page ${f}: serialize matches, parse round-trips`, () => {
    const { page, url, notes } = JSON.parse(read(`pages/${f}`)) as { page: string; url: string; notes: Note[] };
    const md = serializePage(page, url, notes);
    expectFile(`pages/${f.replace(/\.json$/, '.md')}`, md);
    assert.deepEqual(parsePage(md), notes);
    assert.equal(serializePage(page, url, parsePage(md)), md);
  });
}

for (const f of files('edited', '.md')) {
  test(`golden hand-edited ${f}: parses as expected, LF and CRLF alike`, () => {
    const md = read(`edited/${f}`);
    const notes = parsePage(md);
    expectFile(`edited/${f.replace(/\.md$/, '.json')}`, JSON.stringify(notes, null, 2) + '\n');
    assert.deepEqual(parsePage(md.replace(/\n/g, '\r\n')), notes);
    expectFile(`edited/${f.replace(/\.md$/, '.out.md')}`, serializePage(notes[0].page, notes[0].url, notes));
  });
}

for (const f of files('index', '.json')) {
  test(`golden index ${f}`, () => {
    expectFile(`index/${f.replace(/\.json$/, '.md')}`, serializeIndex(JSON.parse(read(`index/${f}`))));
  });
}

test('golden page slugs and file names', () => {
  const cases = JSON.parse(read('slugs.json')) as [string, string | null, string][];
  const actual = cases.map(([page, app]) => [page, app, pageFile(page, app ?? undefined).replace(/\.md$/, '')] as [string, string | null, string]);
  if (update) { writeFileSync(path.join(dir, 'slugs.json'), '[\n' + actual.map(c => '  ' + JSON.stringify(c)).join(',\n') + '\n]\n'); return; }
  for (const [i, c] of cases.entries()) assert.equal(actual[i][2], c[2], `slug of ${c[0]}`);
  assert.equal(pageSlug('/'), 'index');
});
