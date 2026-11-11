// Worktrees (D64): a fresh session runs in its own git worktree on `redline/<session>`; when it ends,
// keep, merge (fast-forward or clean only) or discard (work dropped only when confirmed). Real git in a
// temp repo, the stand-in CLI (test/fixtures/agent/fake-agent.mjs: "write <file> <text>" writes in its folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBridge, TOKEN_HEADER } from '../../agent-bridge/src/handler.ts';
import { slug } from '../../agent-bridge/src/worktrees.ts';

const FAKE = path.resolve('test/fixtures/agent/fake-agent.mjs');
const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

async function repo() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-wt-')));
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.email', 'test@example.com');
  run(root, 'config', 'user.name', 'Test');
  run(root, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(root, 'a.txt'), 'main\n');
  run(root, 'add', '.');
  run(root, 'commit', '-q', '-m', 'first');
  return root;
}

async function serve(root: string, opts: Record<string, unknown> = {}) {
  const bridge = createBridge({ root, command: process.execPath, args: [FAKE], sessions: 'fresh', worktrees: true, worktreeDir: '.redline/worktrees', branchPrefix: 'redline/', ...opts });
  const server = http.createServer((rq, rs) => bridge.handle(rq, rs, new URL(rq.url!, 'http://x').pathname));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${(server.address() as { port: number }).port}`;
  const info = async () => (await fetch(`${base}/info`)).json();
  const post = async (p: string, body: object) => {
    const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: bridge.token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const until = async (ok: (i: any) => boolean, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) { const i = await info(); if (ok(i)) return i; }
    throw new Error(`timed out: ${JSON.stringify(await info())}`);
  };
  const done = (id: string) => until(i => i.sessions.find((s: any) => s.id === id)?.status.state === 'done');
  return { bridge, info, post, until, done, close: () => { bridge.group.dispose(); server.close(); } };
}

test('worktrees: a session per worktree; end → keep, merge (fast-forward), discard (confirm first)', { timeout: 120_000 }, async () => {
  const root = await repo();
  const b = await serve(root);
  try {
    await b.until(i => i.worktrees.git);
    assert.equal((await b.info()).worktrees.on, true);

    // 1. It writes in its own worktree, on its own branch; the main tree is untouched.
    const s1 = (await b.post('/send', { text: 'write b.txt from the agent', title: 'Make it blue!' })).body.id;
    await b.done(s1);
    let s = (await b.info()).sessions.find((x: any) => x.id === s1);
    assert.equal(s.worktree.branch, 'redline/make-it-blue');
    assert.equal(s.worktree.path, '.redline/worktrees/make-it-blue');
    assert.equal(s.worktree.base, 'main');
    const wt = path.join(root, '.redline/worktrees/make-it-blue');
    assert.equal(b.bridge.group.get(s1)!.cwd, wt, 'the CLI runs in the worktree');
    assert.equal(await fs.readFile(path.join(wt, 'b.txt'), 'utf8'), 'from the agent\n');
    assert.ok(!existsSync(path.join(root, 'b.txt')), 'the main tree is untouched');
    assert.equal(run(root, 'status', '--porcelain'), '', 'and stays clean: the worktrees folder ignores itself');

    // 2. Ended: listed for a decision, dirty (b.txt not committed). Discard without confirm is refused.
    await b.post('/end', { id: s1 });
    let left = (await b.until(i => i.worktrees.left[0]?.dirty !== undefined)).worktrees.left;
    assert.deepEqual(left.map((w: any) => [w.branch, w.dirty, w.ahead, w.session, w.title]), [['redline/make-it-blue', true, 0, '#1', 'Make it blue!']]);
    const refused = await b.post('/worktree', { branch: 'redline/make-it-blue', action: 'discard' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.confirm, true);
    assert.match(refused.body.message, /uncommitted changes/);
    assert.ok(existsSync(path.join(wt, 'b.txt')), 'nothing deleted without confirm');
    // Merge refuses uncommitted work too.
    assert.match((await b.post('/worktree', { branch: 'redline/make-it-blue', action: 'merge' })).body.message, /uncommitted changes/);

    // 3. Committed (as the agent would), it merges: a fast-forward; worktree and branch go.
    run(wt, 'add', '.'); run(wt, 'commit', '-q', '-m', 'agent');
    const merged = await b.post('/worktree', { branch: 'redline/make-it-blue', action: 'merge' });
    assert.equal(merged.status, 200, merged.body.message);
    assert.match(merged.body.message, /fast-forward/);
    assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), 'from the agent\n');
    assert.ok(!existsSync(wt));
    assert.equal(run(root, 'branch', '--list', 'redline/*'), '');
    assert.deepEqual((await b.info()).worktrees.left, []);

    // 4. Discard with confirm: worktree and branch gone, the main tree unchanged.
    const s2 = (await b.post('/send', { text: 'write c.txt scratch', title: 'Try c' })).body.id;
    await b.done(s2);
    await b.post('/end', { id: s2 });
    await b.until(i => i.worktrees.left[0]?.dirty === true);
    const gone = await b.post('/worktree', { branch: 'redline/try-c', action: 'discard', confirm: true });
    assert.equal(gone.status, 200);
    assert.ok(!existsSync(path.join(root, '.redline/worktrees/try-c')));
    assert.equal(run(root, 'branch', '--list', 'redline/*'), '');
    assert.ok(!existsSync(path.join(root, 'c.txt')));

    // 5. Keep a clean one: the branch stays, the empty folder goes.
    const s3 = (await b.post('/send', { text: 'hello', title: 'Just look' })).body.id;
    await b.done(s3);
    await b.post('/end', { id: s3 });
    await b.until(i => i.worktrees.left.length === 1);
    const kept = await b.post('/worktree', { branch: 'redline/just-look', action: 'keep' });
    assert.equal(kept.status, 200);
    assert.equal(run(root, 'branch', '--list', 'redline/just-look'), 'redline/just-look');
    assert.ok(!existsSync(path.join(root, '.redline/worktrees/just-look')));

    // 6. A merge that conflicts is refused; both sides stay as they were.
    const s4 = (await b.post('/send', { text: 'write a.txt branch', title: 'Conflict' })).body.id;
    await b.done(s4);
    await b.post('/end', { id: s4 });
    const wt4 = path.join(root, '.redline/worktrees/conflict');
    run(wt4, 'commit', '-q', '-am', 'branch side');
    await fs.writeFile(path.join(root, 'a.txt'), 'main side\n');
    run(root, 'commit', '-q', '-am', 'main side');
    const clash = await b.post('/worktree', { branch: 'redline/conflict', action: 'merge' });
    assert.equal(clash.status, 409);
    assert.match(clash.body.message, /doesn't merge cleanly/);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'main side\n');
    assert.equal(run(root, 'status', '--porcelain'), '');
    assert.equal((await b.info()).worktrees.left.length, 1, 'still listed');

    // 7. Off: a new session runs in the project itself; shared sessions never get one.
    assert.equal((await b.post('/worktrees', { on: false })).body.worktrees.on, false);
    const s5 = (await b.post('/send', { text: 'hello', title: 'Plain' })).body.id;
    await b.done(s5);
    assert.equal(b.bridge.group.get(s5)!.cwd, root);
    assert.equal((await b.info()).sessions.find((x: any) => x.id === s5).worktree, undefined);
  } finally { b.close(); }

  // Restarted (a new process would list them too): an undecided worktree is found again.
  const again = await serve(root, { cwd: '.' });
  try {
    // groupFor reuses the group per root and CLI set in one process; a different cwd key makes a fresh one.
    const left = (await again.until(i => i.worktrees.left.length === 1)).worktrees.left;
    assert.equal(left[0].branch, 'redline/conflict');
    await again.post('/worktree', { branch: 'redline/conflict', action: 'discard', confirm: true });
  } finally { again.close(); }
});

test('worktrees: not a git repo → off, with the reason; turning them on is refused', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-nogit-')));
  const b = await serve(root);
  try {
    const i = await b.until(x => x.worktrees.why !== 'checking…');
    assert.deepEqual([i.worktrees.on, i.worktrees.git, i.worktrees.why], [false, false, 'not a git repository']);
    const r = await b.post('/worktrees', { on: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /git repository/);
  } finally { b.close(); }
  assert.equal(slug('Make it  BLUE — now!'), 'make-it-blue-now');
});
