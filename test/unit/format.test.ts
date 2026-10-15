import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageSlug, parsePage, serializePage } from '../../src/server/format.ts';
import { createStore } from '../../src/server/store.ts';
import { stampJsx } from '../../src/server/jsx-source.ts';
import { loadVueParser, stampVue } from '../../src/server/vue-source.ts';
import { normaliseSource } from '../../src/server/handler.ts';
import type { Note } from '../../src/shared/types.ts';

const base = (o: Partial<Note>): Note => ({
  id: 'abc123', type: 'comment', page: '/agents', url: 'http://localhost/agents', at: '2026-10-13 10:00',
  body: '', reply: '', done: false, ...o,
});

test('round-trips notes through markdown', () => {
  const notes: Note[] = [
    base({ body: 'Make this secondary.\n\nSecond paragraph.', target: { tag: 'button', text: 'Save -- draft', testid: 'save', source: { file: 'src/A.svelte', line: 4 } }, screenshot: '../assets/abc123.png' }),
    base({ id: 'def456', type: 'text', from: 'Old\nline', to: 'New line', body: '', reply: 'Changed in A.svelte', done: true, target: { tag: 'h1', text: 'Old' } }),
    base({ id: 'ghi789', type: 'sketch', whole: true, sketch: '../assets/ghi789.svg', body: '' }),
  ];
  const md = serializePage('/agents', 'http://localhost/agents', notes);
  assert.match(md, /### \[ \] Comment · `button` “Save -- draft” · \[data-testid="save"\] · src\/A\.svelte:4/);
  assert.match(md, /```diff\n- Old\n- line\n\+ New line\n```/);
  assert.ok(!md.includes('Save -- draft"'), 'no raw -- inside the html comment');
  const back = parsePage(md);
  assert.deepEqual(back, notes);
});

test('keeps agent edits: ticked box, replies, CRLF', () => {
  const md = serializePage('/x', undefined, [base({ body: 'Fix it' })])
    .replace(/^### \[ \]/m, '### [x]').replace('Fix it\n', 'Fix it\n\n> Done: renamed.\n> Second line.\n').replace(/\n/g, '\r\n');
  const [n] = parsePage(md);
  assert.equal(n.done, true);
  assert.equal(n.body, 'Fix it');
  assert.equal(n.reply, 'Done: renamed.\nSecond line.');
});

test('page slugs', () => {
  assert.equal(pageSlug('/'), 'index');
  assert.equal(pageSlug('/Acme/proj/agents/12'), 'acme-proj-agents-12');
  assert.equal(pageSlug('/da/om-os/#/x'), 'da-om-os-x');
  assert.ok(pageSlug('/' + 'a'.repeat(200)).length <= 80);
});

test('store: create, update keeps concurrent edits, remove cleans up', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-'));
  const store = createStore({ root });
  const png = 'data:image/png;base64,' + Buffer.from('fake').toString('base64');
  const a = await store.create({ note: { type: 'comment', page: '/', url: 'u', body: 'One' }, screenshot: png });
  const b = await store.create({ note: { type: 'comment', page: '/', url: 'u', body: 'Two' } });
  const file = path.join(root, '.redline/pages/index.md');
  // an agent closes note a by hand
  const md = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, md.replace(/^### \[ \]/m, '### [x]').replace('One\n', 'One\n\n> fixed\n'));
  await store.update(b.id, { body: 'Two, edited' });
  const all = await store.list();
  assert.equal(all.find(n => n.id === a.id)!.done, true);
  assert.equal(all.find(n => n.id === a.id)!.reply, 'fixed');
  assert.equal(all.find(n => n.id === b.id)!.body, 'Two, edited');
  assert.match(await fs.readFile(path.join(root, '.redline/INDEX.md'), 'utf8'), /\| `\/` \| 1 \| 1 \|/);
  assert.ok(await fs.stat(path.join(root, `.redline/assets/${a.id}.png`)));
  await store.remove(a.id);
  await assert.rejects(fs.stat(path.join(root, `.redline/assets/${a.id}.png`)));
  await store.remove(b.id);
  await assert.rejects(fs.stat(file));
});

test('source paths are repo-relative even when root is reached through a link', async () => {
  // Frameworks may report the canonical path while root came from cwd through a symlink/junction
  // (macOS /var → /private/var, Windows 8.3 short names). Used to give ../../../<abs path>.
  const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-src-'));
  const linkRoot = realRoot + '-link';
  await fs.mkdir(path.join(realRoot, 'src/pages'), { recursive: true });
  await fs.writeFile(path.join(realRoot, 'src/pages/index.astro'), '');
  await fs.symlink(realRoot, linkRoot, 'junction');
  try {
    const abs = path.join(realRoot, 'src/pages/index.astro');
    assert.equal(normaliseSource(abs, linkRoot, linkRoot), 'src/pages/index.astro');
    assert.equal(normaliseSource(path.join(linkRoot, 'src/pages/index.astro'), realRoot, realRoot), 'src/pages/index.astro');
    assert.equal(normaliseSource('src/pages/index.astro', linkRoot, linkRoot), 'src/pages/index.astro');
  } finally {
    await fs.rm(linkRoot, { recursive: true, force: true });
    await fs.rm(realRoot, { recursive: true, force: true });
  }
});

test('jsx stamping touches only html tags', () => {
  const src = `export const A = () => <div className="x"><Button/><mesh/><span data-x>{a > b ? <p>hi</p> : null}</span></div>;`;
  const out = stampJsx(src, path.resolve('src/A.tsx'), path.resolve('.'))!;
  assert.match(out.code, /<div data-redline-src="src\/A\.tsx:1:24 A" className/);
  assert.match(out.code, /<span data-redline-src="src\/A\.tsx:1:\d+ A" data-x>/);
  assert.match(out.code, /<p data-redline-src=/);
  assert.match(out.code, /<Button\/>/);
  assert.match(out.code, /<mesh\/>/);
  assert.equal(stampJsx('const x = 1 < 2;', 'a.tsx', '.'), null);
});

test('jsx stamps name the component the element is written in (Solid/Preact chain)', () => {
  const src = [
    'function Card(p) { const row = () => <li>x</li>; return <section>{p.children}</section>; }',
    'export const App = memo(() => <main><Card><b>hi</b></Card></main>);',
    'export default function () { return <p>anon</p>; }',
    'function helper() { return <i>h</i>; }',
  ].join('\n');
  const out = stampJsx(src, path.resolve('src/A.jsx'), path.resolve('.'))!.code;
  assert.match(out, /<li data-redline-src="src\/A\.jsx:1:\d+ Card">/);
  assert.match(out, /<section data-redline-src="src\/A\.jsx:1:\d+ Card">/);
  assert.match(out, /<main data-redline-src="src\/A\.jsx:2:\d+ App">/);
  assert.match(out, /<b data-redline-src="src\/A\.jsx:2:\d+ App">/);
  assert.match(out, /<p data-redline-src="src\/A\.jsx:3:\d+">/);
  assert.match(out, /<i data-redline-src="src\/A\.jsx:4:\d+">/);
});

test('vue stamping: plain HTML elements in the template get file:line:col; components, slots, script untouched', () => {
  const parse = loadVueParser(process.cwd());
  assert.ok(parse, 'vue/compiler-sfc resolves (vue is a devDependency)');
  const src = '<script setup>\nconst a = "<p>not me</p>"\n</script>\n\n<template>\n  <section class="x">\n    <h2 v-if="a < 2">Hi {{ a }}</h2>\n    <Card><b>x</b></Card>\n    <slot />\n  </section>\n</template>\n';
  const out = stampVue(src, path.resolve('src/A.vue'), path.resolve('.'), parse)!.code;
  assert.match(out, /<section data-redline-src="src\/A\.vue:6:3" class="x">/);
  assert.match(out, /<h2 data-redline-src="src\/A\.vue:7:5" v-if=/);
  assert.match(out, /<b data-redline-src="src\/A\.vue:8:11">/);
  assert.match(out, /<Card><b/);
  assert.match(out, /<slot \/>/);
  assert.match(out, /const a = "<p>not me<\/p>"/);
  assert.equal(stampVue('<template lang="pug">\n  p hi\n</template>\n', 'a.vue', '.', parse), null);
});
