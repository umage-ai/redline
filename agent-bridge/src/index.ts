// @umage.ai/agent-bridge (D63): drive agent CLIs (Claude Code, OpenCode, any other) from a browser.
// Sessions in a pseudo-terminal or over the Agent Client Protocol, status from OSC 7501, menus read
// off the screen into data, one HTTP handler with its guards built in. The browser half is
// `@umage.ai/agent-bridge/client`; a CLI that wants to report its status imports `/emit`.

export { createBridge, TOKEN_HEADER, type Bridge, type BridgeSetup } from './handler.ts';
export { AgentGroup, AgentSession, checkPick, resolveCommand, withInstructions, DEFAULT_KEYS } from './sessions.ts';
export { AcpSession, JsonRpc, permissionView, usesAcp } from './acp.ts';
export { adapterFor, baseName, choices, claudeCode, cliChoices, commandName, defaultCommand, generic, installed, onPath, openCode, type CliChoice } from './adapters.ts';
export { decodeText, DA1_REPLY, OscScanner, parseReport, PROBE_REPLY, ProgramRecords, type ProgramReport, type ProgramState, type ProgramStatus, type ScanEvent } from './program-status.ts';
export { parsePrompt, Screen, type Line, type PromptOption, type PromptStep, type PromptView, type Span } from './screen.ts';
export { isLocal } from './http.ts';
export type * from './types.ts';
