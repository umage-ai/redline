// A stand-in Agent Client Protocol agent for the agent panel's ACP mode (D58): newline-delimited
// JSON-RPC 2.0 on stdio. It answers initialize and session/new (a `model` config option with two
// models, an `effort` one of category thought_level), then per prompt streams a thought, a tool call and text, and ends the turn with "did <prompt>".
//   "ask"    asks one permission first (id 0 like OpenCode's first request, L58): "did ask: <optionId>"
//   "slow"   works for 8 s (session/cancel ends it with stopReason cancelled)
//   "crash"  exits with code 7 mid-turn
//   "plan"   sends a plan update
//   "attach" writes acp-notes.md (a tool call with its location) and sends a resource link (D56)
// FAKE_ACP_NO_MODELS: no config options. FAKE_ACP_FAIL_INIT: initialize answers an error.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextId = 0;   // the agent's own request ids start at 0 (OpenCode does)
const waiting = new Map();
const cancelled = new Set();
let model = 'fake/one', effort = 'default';

process.stderr.write('fake acp agent starting\n');
let mcp = '';   // the MCP servers session/new gave it (D66), echoed in its replies
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

const config = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'fake/one', name: 'Fake One' }, { value: 'fake/two', name: 'Fake Two' }] },
  { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort, options: [{ value: 'default', name: 'Default' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];

async function handle(m) {
  if (m.method === undefined) {   // an answer to our request
    waiting.get(m.id)?.(m.result ?? m.error);
    waiting.delete(m.id);
    return;
  }
  const reply = result => send({ jsonrpc: '2.0', id: m.id, result });
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize':
      if (process.env.FAKE_ACP_FAIL_INIT) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required' } });
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } }, authMethods: [], agentInfo: { name: 'FakeACP', version: '1.0.0' }, _seen: p.clientCapabilities });
    case 'session/new':
      mcp = (p.mcpServers ?? []).map(x => `${x.name} ${x.type} ${x.url} ${(x.headers ?? []).map(h => h.name).join(',')}`).join('; ');
      return reply({ sessionId: 'sess_1', ...(process.env.FAKE_ACP_NO_MODELS ? {} : { configOptions: config() }) });
    case 'session/set_config_option':
      if (p.configId === 'model') model = p.value;
      if (p.configId === 'effort') effort = p.value;
      return reply({ configOptions: config() });
    case 'session/cancel':
      cancelled.add(p.sessionId);
      return;
    case 'session/prompt': {
      const sid = p.sessionId;
      cancelled.delete(sid);
      const text = p.prompt.map(c => c.text ?? '').join('');
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } });
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read src/App.tsx', kind: 'read', status: 'pending' });
      await sleep(150);
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      if (text.includes('plan')) update(sid, { sessionUpdate: 'plan', entries: [{ content: 'Look', priority: 'high', status: 'completed' }, { content: 'Fix', priority: 'high', status: 'in_progress' }] });
      if (text.includes('crash')) { await sleep(100); process.exit(7); }
      let answer = '';
      if (text.includes('ask')) {
        const id = nextId++;
        const got = new Promise(r => waiting.set(id, r));
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'echo hello', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello' } });
        send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 't2', title: 'echo hello', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello' } }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject', kind: 'reject_once', name: 'Reject' }] } });
        const r = await got;
        if (r?.outcome?.outcome === 'cancelled' || cancelled.has(sid)) return reply({ stopReason: 'cancelled' });
        answer = `: ${r.outcome.optionId}`;
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: r.outcome.optionId === 'reject' ? 'failed' : 'completed' });
      }
      if (text.includes('attach')) {
        // An edit with its file location, and a link (D56): what the session's attachments pick up.
        writeFileSync('acp-notes.md', '# notes\n');
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Write acp-notes.md', kind: 'edit', status: 'completed', locations: [{ path: path.resolve('acp-notes.md') }] });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: 'https://example.com/spec', name: 'The spec' } });
      }
      if (text.includes('slow')) for (let t = 0; t < 80 && !cancelled.has(sid); t++) await sleep(100);
      if (cancelled.has(sid)) return reply({ stopReason: 'cancelled' });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Working on it.\nmodel ${model} effort ${effort}\n${mcp ? `mcp ${mcp}\n` : ''}` } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `did ${text.trim()}${answer}` } });
      return reply({ stopReason: 'end_turn' });
    }
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  }
}
