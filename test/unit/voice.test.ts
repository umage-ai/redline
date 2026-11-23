// @umage.ai/redline-voice (D71): engines, output parsing, the session timeline, and the plugin's routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHandler } from '../../src/server/handler.ts';
import { parsePage } from '../../src/server/format.ts';
import { parseOutput, runEngine, type Engine } from '../../voice/src/transcribe.ts';
import { sessionMarkdown, timeline, sessionId, type SessionEvent } from '../../voice/src/session.ts';
import { voice } from '../../voice/src/server.ts';

const tmp = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redline-voice-'));
  await fs.mkdir(path.join(root, '.git'));
  return root;
};
const until = async (fn: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('timed out');
};

test('parseOutput reads JSON, SRT, VTT, whisper.cpp lines and plain text', () => {
  assert.deepEqual(parseOutput('  Just text. \n'), { text: 'Just text.' });
  const srt = parseOutput('1\n00:00:00,000 --> 00:00:02,500\nHello there\n\n2\n00:00:02,500 --> 00:00:04,000\nsecond line\ncontinued\n');
  assert.equal(srt.text, 'Hello there second line continued');
  assert.deepEqual(srt.segments![1], { start: 2.5, end: 4, text: 'second line continued' });
  const vtt = parseOutput('WEBVTT\n\n00:01.000 --> 00:02.000\n<v Morten>Make it green\n');
  assert.deepEqual(vtt.segments, [{ start: 1, end: 2, text: 'Make it green' }]);
  const cpp = parseOutput('[00:00:00.000 --> 00:00:03.200]   Move this up.\n[00:00:03.200 --> 00:00:05.000]   And bigger.');
  assert.equal(cpp.text, 'Move this up. And bigger.');
  assert.equal(cpp.segments![1].start, 3.2);
  const oj = parseOutput(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1500 }, text: ' Hi' }] }));
  assert.deepEqual(oj.segments, [{ start: 0, end: 1.5, text: ' Hi' }]);
  assert.equal(parseOutput(JSON.stringify({ text: 'whole', segments: [{ start: 0, end: 1, text: 'whole' }] })).text, 'whole');
});

test('a command engine gets the file and its output is parsed; a failing one reports stderr', async () => {
  const root = await tmp();
  const file = path.join(root, 'a.wav');
  await fs.writeFile(file, 'RIFF');
  const echo: Engine = { command: process.execPath, args: ['-e', 'console.log("[00:00:00.000 --> 00:00:01.000]  got " + require("path").basename(process.argv[1]))', '{file}'] };
  const t = await runEngine(echo as Exclude<Engine, 'browser'>, { file, mime: 'audio/wav' });
  assert.equal(t.text, 'got a.wav');
  assert.deepEqual(t.segments, [{ start: 0, end: 1, text: 'got a.wav' }]);
  const out: Engine = { command: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1] + ".txt", "from file")', '{file}'], outputFile: '{file}.txt' };
  assert.equal((await runEngine(out as Exclude<Engine, 'browser'>, { file, mime: 'audio/wav' })).text, 'from file');
  const bad: Engine = { command: process.execPath, args: ['-e', 'console.error("model not found"); process.exit(3)'] };
  await assert.rejects(runEngine(bad as Exclude<Engine, 'browser'>, { file, mime: 'audio/wav' }), /exited with 3: model not found/);
});

test('an OpenAI-compatible engine posts multipart, asks verbose_json, and falls back to json', async () => {
  const root = await tmp();
  const file = path.join(root, 'n.webm');
  await fs.writeFile(file, 'webm-bytes');
  const seen: { auth?: string; format: string; model: string; name: string; size: number }[] = [];
  const server = http.createServer(async (req, res) => {
    const form = await new Request('http://x' + req.url, { method: 'POST', headers: req.headers as HeadersInit, body: req as never, duplex: 'half' } as RequestInit).formData();
    const f = form.get('file') as File;
    seen.push({ auth: req.headers.authorization, format: String(form.get('response_format')), model: String(form.get('model')), name: f.name, size: f.size });
    if (req.url !== '/v1/audio/transcriptions') { res.statusCode = 404; return res.end(); }
    if (form.get('response_format') === 'verbose_json' && seen.length === 1) { res.statusCode = 400; return res.end('{"error":"unsupported"}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: ' Hello whisper ' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    process.env.TEST_WHISPER_KEY = 'sekrit';
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const t = await runEngine({ url, model: 'large-v3', apiKeyEnv: 'TEST_WHISPER_KEY' }, { file, mime: 'audio/webm' });
    assert.equal(t.text, 'Hello whisper');
    assert.deepEqual(seen.map(s => s.format), ['verbose_json', 'json']);
    assert.equal(seen[0].auth, 'Bearer sekrit');
    assert.equal(seen[0].model, 'large-v3');
    assert.equal(seen[0].name, 'n.webm');
    assert.equal(seen[0].size, 10);
  } finally { server.close(); }
});

test('the timeline merges speech and events by time; untimed transcripts come first', () => {
  const events: SessionEvent[] = [
    { kind: 'point', t: 4000, url: 'http://h/cart', target: { tag: 'button', text: 'Checkout', testid: 'checkout', source: { file: 'src/Cart.tsx', line: 42 }, selector: '[data-testid="checkout"]' }, shot: 'shots/01.png' },
    { kind: 'nav', t: 9000, url: 'http://h/done', title: 'Done' },
  ];
  const md = timeline(events, { segments: [{ start: 1, end: 3, text: 'So this page.' }, { start: 3, end: 4, text: 'This button' }, { start: 5, end: 7, text: 'should be green.' }] });
  assert.equal(md, [
    '**0:01** “So this page. This button”',
    '',
    '**0:04** 👉 **Pointed at** `button` “Checkout” · [data-testid="checkout"] · src/Cart.tsx:42 — `[data-testid="checkout"]`',
    '',
    '![point at 0:04](shots/01.png)',
    '',
    '**0:05** “should be green.”',
    '',
    '**0:09** 🧭 **Went to** /done (“Done”)',
    '', '',
  ].join('\n'));
  const untimed = timeline(events.slice(1), { text: 'All of it.' });
  assert.match(untimed, /^> All of it\.\n\n_The transcript has no timings/);
  assert.match(untimed, /\*\*0:09\*\* 🧭/);
});

test('sessionMarkdown says when the transcript is pending; sessionId is unique and dated', () => {
  const md = sessionMarkdown({ id: 'x', page: '/cart', url: 'http://h/cart', started: '2026-11-23T10:42:00.000Z', duration: 151, events: [], audio: 'audio.webm', transcript: { status: 'queued' } });
  assert.match(md, /Transcript: transcript queued… \(wait for it before acting\)/);
  assert.match(md, /2:31 long, 0 pointers/);
  const taken = new Set(['2026-11-23-1042-cart']);
  assert.equal(sessionId(new Date(2026, 10, 23, 10, 42), '/cart', id => taken.has(id)), '2026-11-23-1042-cart-2');
  assert.equal(sessionId(new Date(2026, 10, 23, 10, 42), '/', () => false), '2026-11-23-1042-home');
});

async function serveVoice(root: string, transcribe: Engine | Engine[]) {
  const { api } = createHandler({ serverRoot: root, clientFile: import.meta.filename, plugins: [voice({ transcribe })] });
  const server = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__redline/p/voice`;
  const post = async (p: string, body: unknown) => (await fetch(base + p, { method: 'POST', headers: { 'x-redline': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { base, post, close: () => new Promise(r => server.close(r)) };
}
const request = (page = '/') => ({ note: { type: 'comment', page, url: `http://h${page}`, body: '', whole: true, viewport: [1280, 800, 1] } });
const audio = { data: Buffer.from('fake-webm').toString('base64'), mime: 'audio/webm;codecs=opus' };
const notesOf = async (root: string, file = 'index.md') => parsePage(await fs.readFile(path.join(root, '.redline/pages', file), 'utf8'));

test('a voice note is saved with a pending body, then the transcript replaces it; WAV goes to the command', async () => {
  const root = await tmp();
  // Reads the file it is handed, so the WAV copy is what it got.
  const engine: Engine = { command: process.execPath, args: ['-e', 'const f=process.argv[1]; console.log("Make the " + require("fs").readFileSync(f, "utf8") + " button green")', '{file}'], label: 'whisper' };
  const s = await serveVoice(root, [engine, 'browser']);
  try {
    const cfg = await (await fetch(s.base + '/config')).json();
    assert.equal(cfg.wav, true);
    assert.deepEqual(cfg.engines, ['whisper', 'browser']);
    const note = await s.post('/notes', { request: request(), audio, wav: Buffer.from('save').toString('base64'), duration: 4.2, live: { text: 'make the safe button green' } });
    assert.equal(note.meta.voice.status, 'queued');
    assert.match(note.body, /^make the safe button green\n\n_\(Live transcript; the final one from whisper is on its way\.\)_/);
    assert.match(note.body, /🎙 \[Recording \(0:04\)\]\(\.\.\/voice\/[a-z0-9]+\.webm\)$/);
    await until(async () => ((await notesOf(root))[0].meta!.voice as { status: string }).status === 'done');
    const [n] = await notesOf(root);
    assert.match(n.body, /^Make the save button green\n\n🎙 \[Recording/);
    assert.equal((n.meta!.voice as { engine: string }).engine, 'whisper');
    const file = (n.meta!.voice as { audio: string }).audio;
    assert.equal(await fs.readFile(path.join(root, '.redline', file), 'utf8'), 'fake-webm');
    assert.equal((await fetch(`${s.base}/audio/${path.basename(file)}`)).headers.get('content-type'), 'audio/webm');
    await assert.rejects(fs.stat(path.join(root, '.redline', file.replace('.webm', '.wav'))), 'the WAV copy goes once transcribed');
  } finally { await s.close(); }
});

test('a failed engine falls back to the browser text; with only failures the note says so, and retry runs again', async () => {
  const root = await tmp();
  const bad: Engine = { command: process.execPath, args: ['-e', 'process.exit(1)'], format: 'webm', label: 'whisper' };
  const s = await serveVoice(root, [bad, 'browser']);
  try {
    await s.post('/notes', { request: request(), audio, duration: 2, live: { text: 'from the browser' } });
    await until(async () => ((await notesOf(root))[0].meta?.voice as { status: string }).status === 'done');
    assert.match((await notesOf(root))[0].body, /^from the browser\n/);

    const n2 = await s.post('/notes', { request: request('/b'), audio, duration: 2 });
    await until(async () => ((await notesOf(root, 'b.md'))[0].meta?.voice as { status: string }).status === 'failed');
    const [f] = await notesOf(root, 'b.md');
    assert.match(f.body, /^_🎙 The transcript failed \(whisper: .*exited with 1/);
    assert.deepEqual(await s.post(`/retry/${n2.id}`, {}), { ok: true });
  } finally { await s.close(); }
});

test('the reviewer’s own edit of a pending voice note is kept when the transcript arrives', async () => {
  const root = await tmp();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const slow = { label: 'slow', transcribe: async () => { await gate; return 'machine text'; } };
  const { api, store } = createHandler({ serverRoot: root, clientFile: import.meta.filename, plugins: [voice({ transcribe: slow })] });
  const server = http.createServer((req, res) => api(req, res, () => res.end()));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__redline`;
    const note = await (await fetch(`${url}/p/voice/notes`, { method: 'POST', headers: { 'x-redline': '1' }, body: JSON.stringify({ request: request(), audio, duration: 1 }) })).json();
    await until(async () => ((await notesOf(root))[0].meta?.voice as { status: string }).status === 'transcribing');
    await store.update(note.id, { body: 'My own words' });
    release();
    await until(async () => ((await notesOf(root))[0].meta?.voice as { status: string }).status === 'done');
    const [n] = await notesOf(root);
    assert.equal(n.body, 'My own words');
    assert.equal((n.meta!.voice as { text: string }).text, 'machine text');
  } finally { server.close(); }
});

test('a session writes its folder, a pointer note, and session.md with the transcript lined up', async () => {
  const root = await tmp();
  const engine = { label: 'whisper', transcribe: async () => ({ text: 'This one should be green.', segments: [{ start: 0.5, end: 2, text: 'This one' }, { start: 2.5, end: 4, text: 'should be green.' }] }) };
  const s = await serveVoice(root, engine);
  try {
    const png = 'data:image/png;base64,' + Buffer.from('png').toString('base64');
    const r = await s.post('/sessions', {
      request: request('/cart'), started: new Date(2026, 10, 23, 10, 42).toISOString(), duration: 5, audio,
      events: [
        { kind: 'point', t: 2200, url: 'http://h/cart', target: { tag: 'button', text: 'Pay', selector: '#pay' }, shot: 'p1' },
        { kind: 'shot', t: 4500, url: 'http://h/cart', shot: 'evil/../../x' },
      ],
      shots: { p1: png, 'evil/../../x': png },
    });
    assert.equal(r.id, '2026-11-23-1042-cart');
    const dir = path.join(root, '.redline/sessions', r.id);
    assert.deepEqual((await fs.readdir(path.join(dir, 'shots'))).sort(), ['01.png', '02.png']);
    await until(async () => JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8')).transcript.status === 'done');
    const md = await fs.readFile(path.join(dir, 'session.md'), 'utf8');
    assert.match(md, /\*\*0:01\*\* “This one”\n\n\*\*0:02\*\* 👉 \*\*Pointed at\*\* `button` “Pay” — `#pay`\n\n!\[point at 0:02\]\(shots\/01\.png\)\n\n\*\*0:03\*\* “should be green\.”/);
    assert.match(md, /!\[shot at 0:05\]\(shots\/02\.png\)/);
    const [n] = await notesOf(root, 'cart.md');
    assert.equal(n.id, r.note);
    assert.equal(n.whole, true);
    assert.match(n.body, /🎬 \*\*Recorded review session\*\*: 0:05, 1 pointer, 2 screenshots; transcribed by whisper\./);
    assert.match(n.body, /\[\.redline\/sessions\/2026-11-23-1042-cart\/session\.md\]\(\.\.\/sessions\/2026-11-23-1042-cart\/session\.md\)/);
    assert.equal((await fetch(`${s.base}/sessions/${r.id}/shots/01.png`)).headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${s.base}/sessions/${r.id}/..%2F..%2Fpages`)).status, 404);
  } finally { await s.close(); }
});
