// Direct source edits (D20): the element is found in source and its content replaced only
// when it is static (text, plus inline markup for rich edits) and equals what the page showed.
// The editAt / editUnique / entity cases live in test/golden/edit/cases.json, which the .NET
// port runs too (EditGoldenTests.cs), so the guards can't drift between the two servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInner, decodeEntities, editAt, editUnique, elementAt, findStartTag, locateAt, spellings, tokenize, validateHtml, type Nth, type Token } from '../../src/server/edit.ts';

interface EditCase {
  name: string; src: string; syntax: 'braces' | 'html';
  at?: { tag: string; line: number; col?: number }; tag?: string; nth?: Nth;
  edit: { from: string; to: string; html?: string };
  content?: string; line?: number; refuse?: string;
}
const golden = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../golden/edit/cases.json'), 'utf8')) as {
  decode: [string, string][]; spell: [string, Record<string, string>][]; edits: EditCase[];
};

for (const c of golden.edits) {
  test(`golden edit: ${c.name}`, () => {
    const braces = c.syntax === 'braces';
    const r = c.at ? editAt(c.src, c.at, c.edit, braces) : editUnique(c.src, c.tag!, c.edit, braces, c.nth);
    if (c.refuse !== undefined) {
      assert.equal(r.ok, false, 'expected a refusal');
      assert.match((r as { reason: string }).reason, new RegExp(c.refuse));
    } else {
      assert.ok(r.ok, !r.ok ? r.reason : '');
      assert.equal(r.ok && r.content, c.content);
      assert.equal(r.ok && r.line, c.line);
    }
  });
}

test('golden: decodeEntities (the full HTML named set, legacy names without ";", numeric edge cases)', () => {
  for (const [input, expected] of golden.decode) assert.equal(decodeEntities(input), expected, input);
});

test('golden: spellings (how the source wrote characters as references)', () => {
  for (const [raw, expected] of golden.spell) assert.deepEqual(spellings(raw), expected, raw);
});

test('tokenize: inline tags kept byte for byte and paired; <br> counts as a space', () => {
  const t = tokenize('Fish &amp; <b>chips</b> on the <a className="m" href=\'#menu\'>menu</a><br />daily', true);
  assert.ok(t.ok);
  const tokens = (t as { tokens: Token[] }).tokens;
  assert.deepEqual(tokens.map(x => x.raw), ['Fish &amp; ', '<b>', 'chips', '</b>', ' on the ', '<a className="m" href=\'#menu\'>', 'menu', '</a>', '<br />', 'daily']);
  assert.equal((tokens[4 + 1] as { close: number }).close, 7);
  assert.equal(tokens[0].k === 'text' && tokens[0].text, 'Fish & ');
  assert.deepEqual(checkInner('Fish &amp; <b>chips</b>', 'Fish & chips', true), { ok: false, reason: 'the element holds markup in source, not just text' });
  assert.equal(tokenize('<b>open', true).ok, false);
  assert.equal(tokenize('</b>x', true).ok, false);
  // event and attribute bindings on inline markup are kept byte for byte
  assert.ok(tokenize('Go <a :href="u" @click="go">home</a> or <a [routerLink]="r" (click)="x()">back</a>', true).ok);
});

test('rich edit: a <br> the editor adds counts as a line break', () => {
  const src = '<p data-testid="r">\n  Fish &amp; <b>chips</b> on the <a className="m" href="#menu">menu</a> daily\n</p>';
  const loc = locateAt(src, { tag: 'p', line: 1 }, 'Fish & chips on the menu daily', true);
  assert.ok(loc.ok && loc.analysis.rich);
  assert.deepEqual(validateHtml('a<br />b', loc.ok ? loc.analysis.tokens : [], 'a\nb', true), { ok: true });
});

test('elementAt: nested same tag, quoted >, self-closing', () => {
  const src = '<div title="a>b"><div>in</div>out</div>';
  const r = elementAt(src, 0, 'div')!;
  assert.equal(src.slice(r.innerStart, r.innerEnd), '<div>in</div>out');
  assert.equal(elementAt('<img src="x" />', 0, 'img'), null);
  assert.equal(elementAt('<p>never closed', 0, 'p'), null);
  assert.equal(findStartTag('<pre>x</pre><p>y</p>', 'p', 1), 12);   // <pre> is not <p>
});

test('checkInner normalises whitespace and nbsp the way innerText does', () => {
  assert.deepEqual(checkInner('\n   Two&nbsp;words\n  ', 'Two words', true), { ok: true });
});
