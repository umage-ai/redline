// Direct source edits (D20): the element is found in source and its content replaced only
// when it is static (text, plus inline markup for rich edits) and equals what the page showed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInner, editAt, editUnique, elementAt, findStartTag, locateAt, tokenize, validateHtml, type Token } from '../../src/server/edit.ts';

type Planned = ReturnType<typeof editAt>;
const ok = (r: Planned) => { assert.ok(r.ok, !r.ok ? r.reason : ''); return r.ok ? r : (null as never); };
const no = (r: Planned, re: RegExp) => { assert.equal(r.ok, false); assert.match((r as { reason: string }).reason, re); };
const plain = (from: string, to: string) => ({ from, to });

test('astro: edits static text at line:col, keeps attributes and whitespace', () => {
  const src = '---\nconst t = 1;\n---\n<section>\n  <h1 class="x" data-a={t > 0}>\n    Hello  world\n  </h1>\n</section>\n';
  const r = ok(editAt(src, { tag: 'h1', line: 5, col: 3 }, plain('Hello world', 'Hi & <bye>'), true));
  assert.equal(r.content, '---\nconst t = 1;\n---\n<section>\n  <h1 class="x" data-a={t > 0}>\n    Hi &amp; &lt;bye&gt;\n  </h1>\n</section>\n');
  assert.equal(r.line, 5);
});

test('refuses expressions, block markup, components, comments and text that differs from the page', () => {
  no(editAt('<button>Clicked {n}</button>', { tag: 'button', line: 1 }, plain('Clicked 0', 'x'), true), /expression/);
  no(editAt('<p>Hi <div>there</div></p>', { tag: 'p', line: 1 }, plain('Hi there', 'x'), true), /<div>/);
  no(editAt('<p>Hi <Badge>new</Badge></p>', { tag: 'p', line: 1 }, plain('Hi new', 'x'), true), /component/);
  no(editAt('<p>Hi <a href={url}>x</a></p>', { tag: 'p', line: 1 }, plain('Hi x', 'y'), true), /attribute .*expression/);
  no(editAt('<p>Hi <!-- c --></p>', { tag: 'p', line: 1 }, plain('Hi', 'x'), true), /comment/);
  no(editAt('<p>{t("hello")}</p>', { tag: 'p', line: 1 }, plain('Hello', 'x'), true), /expression/);
  no(editAt('<p>Hello</p>', { tag: 'p', line: 1 }, plain('Bonjour', 'x'), true), /differs/);
  no(editAt('<p>Hello</p>', { tag: 'h1', line: 1 }, plain('Hello', 'x'), true), /no <h1> on line 1/);
  no(editAt('<p>Hello</p>', { tag: 'p', line: 9 }, plain('Hello', 'x'), true), /no <p> on line 9/);
  // inline markup without the rich editor's html would drop the tags
  no(editAt('<p>Hi <b>there</b></p>', { tag: 'p', line: 1 }, plain('Hi there', 'Hi you'), true), /edit it in place/);
});

test('JSX: braces in the new text are encoded; a stamped line:col picks the right element', () => {
  const src = 'export const A = () => (\n  <div><p>One</p><p>Two</p></div>\n);\n';
  const at = { tag: 'p', line: 2, col: src.split('\n')[1].indexOf('<p>Two') + 1 };
  assert.equal(ok(editAt(src, at, plain('Two', 'Two {2}'), true)).content.split('\n')[1], '  <div><p>One</p><p>Two &#123;2&#125;</p></div>');
});

test('plain HTML: braces are text; entities compare decoded', () => {
  const r = ok(editAt('<h2>Fish &amp; chips {daily}</h2>', { tag: 'h2', line: 1 }, plain('Fish & chips {daily}', 'Fish {weekly}'), false));
  assert.equal(r.content, '<h2>Fish {weekly}</h2>');
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
});

test('rich edit: the editor\'s html keeps original tags and may add simple ones; nothing else gets in', () => {
  const src = '<p data-testid="r">\n  Fish &amp; <b>chips</b> on the <a className="m" href="#menu">menu</a> daily\n</p>';
  const at = { tag: 'p', line: 1 };
  const from = 'Fish & chips on the menu daily';
  const html = '\n  Fish &amp; <b>chips</b> on the <a className="m" href="#menu">menu</a> daily <i>now</i>\n';
  const r = ok(editAt(src, at, { from, to: 'Fish & chips on the menu daily now', html }, true));
  assert.equal(r.content, `<p data-testid="r">${html}</p>`);

  no(editAt(src, at, { from, to: 'x', html: 'x <script>alert(1)</script>' }, true), /<script>/);
  no(editAt(src, at, { from, to: 'menu', html: '<a href="https://evil">menu</a>' }, true), /wasn't there/);
  no(editAt(src, at, { from, to: 'a b', html: 'a <b>b' }, true), /invalid/);
  no(editAt(src, at, { from, to: 'different text', html: 'Fish' }, true), /disagree/);
  no(editAt(src, at, { from, to: 'x {y}', html: 'x {y}' }, true), /expression/);

  const loc = locateAt(src, at, from, true);
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

test('editUnique: the one element with this text, refuses when ambiguous or absent', () => {
  const html = '<main>\n<h1 id="t">Agent settings</h1>\n<p>Save</p>\n<button>Save</button>\n<button>Save</button>\n</main>';
  assert.match(ok(editUnique(html, 'h1', plain('Agent settings', 'Agent options'))).content, /<h1 id="t">Agent options<\/h1>/);
  assert.equal(ok(editUnique(html, 'h1', plain('Agent settings', 'x'))).line, 2);
  no(editUnique(html, 'button', plain('Save', 'Store')), /2 <button> elements/);
  no(editUnique(html, 'h2', plain('Agent settings', 'x')), /no <h2>/);
});

test('checkInner normalises whitespace and nbsp the way innerText does', () => {
  assert.deepEqual(checkInner('\n   Two&nbsp;words\n  ', 'Two words', true), { ok: true });
});

test('Vue / Angular directives on inline markup are refused: what shows depends on state', () => {
  no(editAt('<p>Hi <b v-if="on">there</b></p>', { tag: 'p', line: 1 }, plain('Hi there', 'x'), true), /directive/);
  no(editAt('<p>Hi <span v-html="h"></span></p>', { tag: 'p', line: 1 }, plain('Hi', 'x'), true), /directive/);
  no(editAt('<p>Hi <b *ngIf="on">there</b></p>', { tag: 'p', line: 1 }, plain('Hi there', 'x'), true), /directive/);
  no(editAt('<p>Hi <span [innerHTML]="h"></span></p>', { tag: 'p', line: 1 }, plain('Hi', 'x'), true), /directive/);
  // event and attribute bindings on inline markup are kept byte for byte
  assert.ok(tokenize('Go <a :href="u" @click="go">home</a> or <a [routerLink]="r" (click)="x()">back</a>', true).ok);
});
