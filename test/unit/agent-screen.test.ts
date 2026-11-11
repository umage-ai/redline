// What the agent asks, read off its screen (D53): parsePrompt on real Claude Code screens
// (test/fixtures/agent/screens, captured from Claude Code 2.1 through a headless terminal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePrompt, Screen, type Line } from '../../agent-bridge/src/screen.ts';

const screen = (name: string): Line[] => readFileSync(`test/fixtures/agent/screens/${name}.txt`, 'utf8').split('\n').map(text => ({ text }));
const labels = (v: ReturnType<typeof parsePrompt>) => v?.options.map(o => `${o.selected ? '>' : ' '}${o.n ?? '-'} ${o.label}`);

test('prompt: an edit permission with its diff', () => {
  const v = parsePrompt(screen('claude-edit'))!;
  assert.equal(v.question, 'Do you want to make this edit to notes.txt?');
  assert.deepEqual(labels(v), ['>1 Yes', ' 2 No']);
  assert.equal(v.hint, 'Esc to cancel · Tab to amend');
  const ctx = v.lines.map(l => l.map(s => s.t).join('').trim());
  assert.deepEqual(ctx.filter(Boolean).filter(l => !/^╌+$/.test(l)), ['Edit file', 'notes.txt', '1 -hello', '1 +hello world']);
  assert.equal(v.steps, undefined);
});

test('prompt: stepped questions (steps, descriptions, "Type something"), and the review step', () => {
  const v = parsePrompt(screen('claude-questions-1'))!;
  assert.deepEqual(v.steps?.map(s => `${s.state}:${s.label}`), ['todo:Color', 'todo:Size', 'submit:Submit']);
  assert.equal(v.question, 'Which colour should the button be?');
  assert.deepEqual(labels(v), ['>1 Red', ' 2 Blue', ' 3 Green', ' 4 Type something.', ' 5 Chat about this']);
  assert.match(v.options[1].description!, /^Calm and trustworthy/);
  assert.equal(v.options[3].input, true);
  assert.equal(v.lines.length, 0);
  const v2 = parsePrompt(screen('claude-questions-2'))!;
  assert.deepEqual(v2.steps?.map(s => s.state), ['done', 'todo', 'submit']);
  assert.deepEqual(labels(v2), ['>1 Small', ' 2 Large', ' 3 Type something.', ' 4 Chat about this']);
  const r = parsePrompt(screen('claude-questions-review'))!;
  assert.equal(r.question, 'Ready to submit your answers?');
  assert.deepEqual(labels(r), ['>1 Submit answers', ' 2 Cancel']);
  assert.ok(r.lines.some(l => l.map(s => s.t).join('').includes('→ Blue')), 'the answers so far are shown above');
});

test('prompt: a list without numbers needs the key hint; the input line is never a menu', () => {
  const t = parsePrompt(screen('claude-trust'))!;
  assert.deepEqual(labels(t), [' - No, exit', '>- Yes, I trust this folder']);
  assert.match(t.question!, /Security guide/);
  assert.equal(parsePrompt(screen('claude-idle-input')), null);
  // A multi-line prompt typed into the input box (❯ plus indented lines) is not a menu either.
  assert.equal(parsePrompt([{ text: '❯ Use the AskUserQuestion tool to ask me' }, { text: '  two questions at once' }, { text: '  and tell me.' }, { text: '────────────' }, { text: '  ? for shortcuts' }]), null);
});

test('prompt: a menu already answered, left on screen with output below it, is not a menu (the card used to stay up)', () => {
  const answered = [...screen('claude-edit'), { text: '' }, { text: '● Updated notes.txt (1 line)' }, { text: '' }, { text: '> ' }];
  assert.equal(parsePrompt(answered), null);
  assert.ok(parsePrompt(screen('claude-edit')), 'live: the hint is the bottom line');
});

test('screen: colours survive (a red and a green diff line), the menu is read from the live screen', async () => {
  const s = new Screen(60, 12);
  s.write('\x1b[2J\x1b[H Edit file\r\n\x1b[41m 1 -old \x1b[0m\r\n\x1b[42m 1 +new \x1b[0m\r\n Do it?\r\n \x1b[1m❯ 1. Yes\x1b[0m\r\n   2. No\r\n Esc to cancel');
  await new Promise(r => setTimeout(r, 50));
  const v = s.prompt()!;
  assert.equal(v.question, 'Do it?');
  assert.deepEqual(labels(v), ['>1 Yes', ' 2 No']);
  const red = v.lines[1].find(sp => sp.t.includes('-old'));
  assert.ok(red?.bg, 'the removed line keeps its background colour');
  s.dispose();
});
