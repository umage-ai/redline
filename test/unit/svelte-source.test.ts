// Svelte source stamps for builds (D43): HTML elements get data-redline-src="file:line:col Component";
// components, <svelte:*> elements, <svelte:head>, script and style are left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadSvelteParser, stampSvelte } from '../../src/server/svelte-source.ts';

const root = path.resolve('test/fixtures/sveltekit');
const parse = loadSvelteParser(process.cwd());

const SRC = `<script lang="ts">
  let { items }: { items: string[] } = $props();
  const html = '<div>not markup</div>';
</script>

<svelte:head><title>Board</title></svelte:head>

<section class="board">
  {#if items.length}
    <ul>
      {#each items as item}<li>{item}</li>{/each}
    </ul>
  {:else}
    <p data-redline-src="kept:1:1">Empty</p>
  {/if}
  <Card title="x"><span>inside a component</span></Card>
</section>

<style>
  div { color: red; }
</style>
`;

test('stamps HTML elements with file, line, column and the component name; skips the rest', () => {
  assert.ok(parse, 'svelte/compiler is a dev dependency');
  const file = path.join(root, 'src/routes/Board.svelte');
  const out = stampSvelte(SRC, file, root, parse!);
  assert.ok(out);
  const rel = 'src/routes/Board.svelte';
  assert.match(out.code, new RegExp(`<section data-redline-src="${rel}:8:1 Board" class="board">`));
  assert.match(out.code, new RegExp(`<ul data-redline-src="${rel}:10:5 Board">`));
  assert.match(out.code, new RegExp(`<li data-redline-src="${rel}:11:28 Board">`));
  assert.match(out.code, new RegExp(`<span data-redline-src="${rel}:16:19 Board">`), 'elements in a component\'s slot are ours');
  assert.match(out.code, /<p data-redline-src="kept:1:1">/, 'an existing stamp is kept');
  assert.match(out.code, /<title>Board<\/title>/, '<svelte:head> is not stamped');
  assert.match(out.code, /<Card title="x">/);
  assert.match(out.code, /const html = '<div>not markup<\/div>';/, 'script text is untouched');
  assert.ok(out.map.includes('"mappings"'));
});

test('unparseable or element-free input is left alone', () => {
  assert.equal(stampSvelte('{#if}', 'x.svelte', root, parse!), null);
  assert.equal(stampSvelte('just text', 'x.svelte', root, parse!), null);
});
