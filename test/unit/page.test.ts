// The page key notes are grouped by (src/shared/page.ts): one notes file and pin set per key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageKey } from '../../src/shared/page.ts';

const at = (pathname: string, hash = '') => ({ pathname, hash });

test("'route' (default): path plus hash routes; index.html and trailing slashes fold", () => {
  assert.equal(pageKey(at('/deck/index.html', '#/3')), '/deck#/3');
  assert.equal(pageKey(at('/deck/', '#/3?x=1')), '/deck#/3');
  assert.equal(pageKey(at('/a%20b/', '#section')), '/a b');   // a plain anchor is not a route
  assert.equal(pageKey(at('/')), '/');
});

test("'path': hash routes share one key (a slide deck keeps one notes file)", () => {
  assert.equal(pageKey(at('/deck/index.html', '#/3'), 'path'), '/deck');
  assert.equal(pageKey(at('/deck/', '#/4/2'), 'path'), '/deck');
});
