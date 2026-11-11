// @umage.ai/redline-agent (D53): the agent panel for Redline's dev server, on its own so nobody
// installs a pseudo-terminal they don't use. Two ways in:
//   redline({ agent: true })                        // the core finds this package in the project
//   import { agent } from '@umage.ai/redline-agent';
//   redline({ agent: agent({ command: 'codex' }) })  // explicit, typed
// Built as one CommonJS file (the core loads it synchronously, and bundlers parsing a config don't
// trip over a dynamic import), next to the panel's browser files (panel.js, terminal.js). The agent
// bridge (agent-bridge/, D63: sessions, adapters, OSC 7501, the routes) is bundled in, so the
// package has no new dependency.

import type { AgentOptions, AgentPlugin } from '../../src/server/agent-hook.ts';
import { agentRoutes } from './server.ts';

export type { AgentOptions, AgentCommand, AgentPlugin, AgentRoutes, AgentAdapter, AgentStart, AgentChoice, AgentCli, BridgeOptions, SessionInfo } from '../../src/server/agent-hook.ts';
/** The built-in adapters (D55), to extend or wrap: `adapters: [{ ...openCode, settleMs: 2000 }]`. */
export { claudeCode, openCode, adapterFor } from '../../agent-bridge/src/adapters.ts';

/** The agent panel for the `agent` option: `true` is `agent()`, `'codex'` is `agent({ command: 'codex' })`. */
export function agent(opts: AgentOptions = {}): AgentPlugin {
  return { routes: ({ root, base }) => agentRoutes(opts, root, base) };
}
