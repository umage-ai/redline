// Types for @umage.ai/redline-agent. The option types are Redline's own (the `agent` option).
import type { AgentOptions, AgentPlugin } from '@umage.ai/redline/server';
export type { AgentOptions, AgentCommand, AgentPlugin, AgentRoutes } from '@umage.ai/redline/server';

/** The agent panel for the `agent` option: `redline({ agent: agent({ command: 'codex' }) })`. */
export declare function agent(opts?: AgentOptions): AgentPlugin;
