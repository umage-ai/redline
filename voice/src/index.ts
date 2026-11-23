// @umage.ai/redline-voice (D71): voice notes and recorded review sessions for Redline's dev server.
//   import { voice } from '@umage.ai/redline-voice';
//   redline({ plugins: [voice({ transcribe: [{ url: 'http://localhost:8000/v1' }, 'browser'] })] })
// Built as one CommonJS file (like the agent panel: configs that `require` it work too), next to the
// overlay extension it serves (extension.js).

export { voice, voiceRoutes } from './server.ts';
export type { VoiceOptions, VoiceMeta } from './server.ts';
export { parseOutput, runEngine } from './transcribe.ts';
export type { Engine, HttpEngine, CommandEngine, TranscribeFn, AudioInput, Segment, Transcript } from './transcribe.ts';
export { sessionMarkdown, timeline } from './session.ts';
export type { SessionData, SessionEvent } from './session.ts';
