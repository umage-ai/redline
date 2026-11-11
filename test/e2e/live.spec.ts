// Live pages (D65) in a real browser: the injected overlay keeps /__redline/live open, so the dev
// server's MCP tools can ask it for its console errors and the DOM around a note's target, and say
// so when no tab is open. Vanilla fixture.
import { test, expect, type APIRequestContext } from '@playwright/test';
import { FIXTURES } from './fixtures.ts';
import { comment, openOverlay, resetNotes } from './helpers.ts';

const f = FIXTURES.vanilla;
test.beforeEach(() => resetNotes(f));

const tool = async (request: APIRequestContext, name: string, args: object = {}) => {
  const r = await request.post(`${f.url}/__redline/mcp`, { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  expect(r.status()).toBe(200);
  return ((await r.json()).result.content as { text: string }[]).map(c => c.text).join('\n');
};

test('MCP live tools: page_console and note_dom answer from the open tab; check_page loads the page; none open: they say so', async ({ page, request }) => {
  await openOverlay(page, f);
  await page.keyboard.press('c');
  const saved = await comment(page, page.getByTestId('agent-save'), 'Make this secondary');
  await page.evaluate(() => console.error('Boom from the app'));

  await expect.poll(() => tool(request, 'page_console', { path: '/' })).toContain('Boom from the app');
  const dom = await tool(request, 'note_dom', { id: saved.id });
  expect(dom).toContain('"element": "button"');
  expect(dom).toContain('"text": "Save draft"');
  expect(dom).toContain('data-testid=\\"agent-save\\"');
  const check = await tool(request, 'check_page', { path: '/' });
  expect(check).toMatch(/GET \/ → 200 \(text\/html/);
  expect(check).toContain('Boom from the app');

  await page.close();
  await expect.poll(() => tool(request, 'page_console')).toContain('No browser tab has this app open');
});
