// Attachments (D56): what a session pointed at, per round. Detection (OSC 8, URLs and paths with the
// folder check, a git round diff), the served files (inside the session's folder only, images and
// text), and the stand-in CLIs end to end over the bridge's routes (PTY: OSC 8 + mentions + changed
// files; ACP: a tool call's location and a resource link).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs, symlinkSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, fileDiff, fileType, inside, localUrl, mentions, osc8Links, Rounds, snapshot, stripAnsi } from '../../agent-bridge/src/attachments.ts';
import { createBridge, TOKEN_HEADER } from '../../agent-bridge/src/handler.ts';
import { groupAttachments, isLocalUrl, type Attached } from '../../agent/src/panel.ts';

const ESC = '\x1b', ST = '\x1b\\';
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const tmp = async (name: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), name)));
async function repo() {
  const root = await tmp('agent-att-');
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.email', 't@example.com'); run(root, 'config', 'user.name', 'T'); run(root, 'config', 'core.autocrlf', 'false');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/a.ts'), 'one\ntwo\n');
  await fs.writeFile(path.join(root, 'gone.txt'), 'bye\n');
  run(root, 'add', '.'); run(root, 'commit', '-q', '-m', 'first');
  return root;
}

test('OSC 8: links with their text, BEL or ST, each once; ANSI stripped', () => {
  const out = `x ${ESC}]8;id=1;https://example.com/a${ST}${ESC}[1mthe A${ESC}[0m${ESC}]8;;${ST} y ${ESC}]8;;file:///tmp/b.png\x07pic${ESC}]8;;\x07 ${ESC}]8;;https://example.com/a${ST}again${ESC}]8;;${ST}`;
  assert.deepEqual(osc8Links(out), [{ uri: 'https://example.com/a', text: 'the A' }, { uri: 'file:///tmp/b.png', text: 'pic' }]);
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m ${ESC}]0;title\x07ok`).replace(/\s+/g, ' ').trim(), 'red ok');
});

test('mentions: URLs, and paths only when the file exists inside the folder', async () => {
  const root = await tmp('agent-men-');
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/App.tsx'), '');
  await fs.writeFile(path.join(root, 'README.md'), '');
  const outside = await tmp('agent-out-');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
  const text = `Edited src/App.tsx:12:3 and README.md. See http://localhost:5173/settings. Not ${path.join(outside, 'secret.txt')}, not ../${path.basename(outside)}/secret.txt, not nope.ts, not (src/App.tsx) twice.`;
  const m = mentions(text, root);
  assert.deepEqual(m.urls, ['http://localhost:5173/settings']);
  assert.deepEqual(m.paths, ['src/App.tsx', 'README.md']);
  assert.equal(localUrl('http://localhost:5173/x'), true);
  assert.equal(localUrl('http://app.localhost/x'), true);
  assert.equal(localUrl('https://example.com'), false);
  assert.equal(localUrl('javascript:alert(1)'), false);
});

test('inside: the folder only, no .., no absolute path elsewhere, no symlink (junction) out', async () => {
  const root = await tmp('agent-in-'), outside = await tmp('agent-out-');
  await fs.writeFile(path.join(root, 'ok.png'), '');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, path.join(root, 'link'), 'junction');   // a directory link that works without admin on Windows
  assert.deepEqual(inside(root, 'ok.png')?.rel, 'ok.png');
  assert.equal(inside(root, '../' + path.basename(outside) + '/secret.txt'), null);
  assert.equal(inside(root, path.join(outside, 'secret.txt')), null);
  assert.equal(inside(root, 'link/secret.txt'), null, 'a link pointing out');
  assert.equal(inside(root, 'missing.png'), null);
  assert.equal(inside(root, ''), null);
  assert.deepEqual(fileType('a/b.PNG'), { type: 'image/png', image: true });
  assert.equal(fileType('tool.exe'), null);
  assert.equal(fileType('src/x.ts')?.image, false);
});

test('a round in git: snapshot before and after; changed, added, deleted (untracked included); one file\'s diff', async () => {
  const root = await repo();
  const before = await snapshot(root);
  assert.ok(before);
  await fs.writeFile(path.join(root, 'src/a.ts'), 'one\nTWO\nthree\n');
  await fs.writeFile(path.join(root, 'new.md'), 'hi\n');
  await fs.rm(path.join(root, 'gone.txt'));
  const after = await snapshot(root);
  assert.notEqual(after, before);
  assert.equal(run(root, 'status', '--porcelain'), 'D gone.txt\n M src/a.ts\n?? new.md'.split('\n').join('\n'), 'the real index is untouched');
  const files = await changedFiles(root, before!, after!);
  assert.deepEqual(files.map(f => [f.path, f.status, f.added, f.removed]).sort(), [['gone.txt', 'D', 0, 1], ['new.md', 'A', 1, 0], ['src/a.ts', 'M', 2, 1]]);
  assert.match(await fileDiff(root, before!, after!, 'src/a.ts'), /^\+TWO$/m);
  assert.equal(await snapshot(await tmp('agent-nogit-')), null, 'not a repo: no snapshot');

  // Rounds: changed files, OSC 8 links, mentions (files that exist), and explicit ones; repeats merge.
  const changes: number[] = [];
  const rounds = new Rounds(root, root, () => changes.push(1));
  await rounds.begin('Apply notes');
  await fs.writeFile(path.join(root, 'src/a.ts'), 'changed\n');
  rounds.feed(`Done: ${ESC}]8;;http://localhost:5173/x${ST}preview${ESC}]8;;${ST}, edited src/a.ts and see https://example.com/doc`);
  assert.equal(rounds.addFile('../escape.txt', 'explicit'), null, 'outside the folder: refused');
  rounds.addFile('src/a.ts', 'explicit', 'The component');
  await rounds.finish();
  const r = rounds.view()[0];
  assert.equal(r.task, 'Apply notes');
  assert.deepEqual(r.items.map(i => [i.source, i.kind, i.path ?? i.url, i.title]), [
    ['explicit', 'file', 'src/a.ts', 'The component'],
    ['changed', 'diff', 'src/a.ts', undefined],
    ['link', 'url', 'http://localhost:5173/x', 'preview'],
    ['mentioned', 'url', 'https://example.com/doc', undefined],
  ]);
  assert.equal(rounds.count, 3, 'mentions are not counted');
  assert.match((await rounds.diff(1, 'src/a.ts'))!, /^\+changed$/m);
});

test('attachment routes: the list, files inside the session\'s folder only (images and text), diffs; the token', async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(root, 'tool.exe'), 'MZ');
  const bridge = createBridge({ root, command: process.execPath });
  const s = bridge.group.create();
  s.rounds.addFile('shot.png', 'explicit', 'Before');
  assert.ok('error' in bridge.group.attach(s.id, { path: '../x' }));
  assert.ok('error' in bridge.group.attach(s.id, { url: 'javascript:alert(1)' }));
  assert.ok('ok' in bridge.group.attach(s.id, { url: 'http://localhost:5173/', title: 'Home' }));
  const server = http.createServer((rq, rs) => bridge.handle(rq, rs, new URL(rq.url!, 'http://x').pathname));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}`;
  const get = (p: string, token = bridge.token) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}token=${token}`);
  try {
    const list = await (await get(`/attachments?id=${s.id}`)).json();
    assert.deepEqual(list.rounds[0].items.map((i: any) => [i.kind, i.path ?? i.url, i.title]), [['image', 'shot.png', 'Before'], ['url', 'http://localhost:5173/', 'Home']]);
    assert.equal((await get(`/attachments?id=${s.id}`, 'nope')).status, 403);
    const img = await get(`/file?id=${s.id}&path=shot.png`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.match(img.headers.get('content-security-policy')!, /sandbox/);
    assert.equal((await get(`/file?id=${s.id}&path=tool.exe`)).status, 404, 'not an image or text');
    assert.equal((await get(`/file?id=${s.id}&path=${encodeURIComponent('../' + path.basename(root) + '/shot.png')}`)).status, 200, '.. that comes back inside is fine');
    assert.equal((await get(`/file?id=${s.id}&path=${encodeURIComponent(os.tmpdir())}`)).status, 404, 'outside the folder');
    assert.equal((await get(`/file?id=${s.id}&path=.git/config`)).status, 404, 'no extension we serve');
    assert.equal((await get(`/diff?id=${s.id}&round=1&path=shot.png`)).status, 404, 'not a changed file');
    assert.equal((await (await get('/info')).json()).sessions[0].attachments, 2);
  } finally { server.close(); bridge.group.dispose(); }
});

test('the stand-in CLIs: a PTY round (OSC 8, mentions, changed files) and an ACP round (location, resource link)', { timeout: 60_000 }, async () => {
  const root = await repo();
  await fs.writeFile(path.join(root, 'index.html'), '<p>hi</p>');
  run(root, 'add', '.'); run(root, 'commit', '-q', '-m', 'page');
  for (const [protocol, script, prompt] of [['pty', 'fake-agent.mjs', 'write out.txt link made'], ['acp', 'fake-acp-agent.mjs', 'attach please']] as const) {
    const bridge = createBridge({ root, command: process.execPath, args: [path.resolve('test/fixtures/agent', script)], protocol, sessions: 'fresh' });
    const server = http.createServer((rq, rs) => bridge.handle(rq, rs, new URL(rq.url!, 'http://x').pathname));
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://localhost:${(server.address() as { port: number }).port}`;
    try {
      const sent = await (await fetch(`${base}/send`, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: bridge.token }, body: JSON.stringify({ text: prompt, task: 'Try it' }) })).json();
      let items: any[] = [];
      for (const end = Date.now() + 30_000; Date.now() < end; await new Promise(r => setTimeout(r, 150))) {
        const list = await (await fetch(`${base}/attachments?id=${sent.id}&token=${bridge.token}`)).json();
        if (list.rounds[0]?.done) { items = list.rounds[0].items; assert.equal(list.rounds[0].task, 'Try it'); break; }
      }
      const got = items.map(i => `${i.source} ${i.kind} ${i.path ?? i.url}`);
      if (protocol === 'pty') {
        // The prompt line ("write out.txt link made") is echoed too: out.txt also shows as mentioned-then-changed (merged).
        assert.ok(got.includes('changed diff out.txt'), got.join('; '));
        assert.ok(got.includes('link url http://localhost:5199/preview'), got.join('; '));
        assert.ok(got.includes('mentioned file index.html'), got.join('; '));
        assert.ok(!got.some(g => g.includes('missing.md')), 'a file that doesn\'t exist is not mentioned');
      } else {
        assert.ok(got.includes('explicit file acp-notes.md'), got.join('; '));
        assert.ok(got.includes('explicit url https://example.com/spec'), got.join('; '));
        assert.ok(got.includes('changed diff acp-notes.md'), got.join('; '));
      }
    } finally { server.close(); bridge.group.dispose(); }
  }
});

test('the card\'s groups: images (changed ones too), changed files, files, links, mentions apart; local links only open', () => {
  const items = [
    { id: '1-1', round: 1, source: 'changed', kind: 'diff', path: 'src/a.ts', added: 2, removed: 1, status: 'M' },
    { id: '1-2', round: 1, source: 'changed', kind: 'diff', path: 'shot.png', added: 0, removed: 0, status: 'A' },
    { id: '1-3', round: 1, source: 'changed', kind: 'diff', path: 'old.png', added: 0, removed: 0, status: 'D' },
    { id: '1-4', round: 1, source: 'explicit', kind: 'image', path: 'before.png' },
    { id: '1-5', round: 1, source: 'explicit', kind: 'file', path: 'notes.md' },
    { id: '1-6', round: 1, source: 'link', kind: 'url', url: 'http://localhost:5173/' },
    { id: '1-7', round: 1, source: 'mentioned', kind: 'file', path: 'README.md' },
  ] as Attached[];
  const g = groupAttachments(items);
  assert.deepEqual(g.images.map(i => i.path), ['shot.png', 'before.png'], 'a deleted image has nothing to show');
  assert.deepEqual(g.changed.map(i => i.path), ['src/a.ts', 'shot.png', 'old.png']);
  assert.deepEqual([g.files.length, g.links.length, g.mentioned.length], [1, 1, 1]);
  assert.equal(isLocalUrl('http://127.0.0.1:5173/a'), true);
  assert.equal(isLocalUrl('https://evil.example/localhost'), false);
});
