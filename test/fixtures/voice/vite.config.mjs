import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import redline from '../../../dist/vite.js';
import { voice } from '../../../voice/dist/index.cjs';

const root = fileURLToPath(new URL('.', import.meta.url));
// The voice plugin (D71) with a stand-in engine: Chrome's fake microphone only beeps, so the
// "transcript" is fixed, with timings so the session timeline can be checked. No live transcript:
// the Web Speech API needs Google's service, which a test can't count on.
const fake = {
  label: 'fake-whisper',
  transcribe: async () => ({ text: 'Make this button green. And take a picture.', segments: [{ start: 0, end: 0.4, text: 'Make this button green.' }, { start: 60, end: 61, text: 'And take a picture.' }] }),
};
export default defineConfig({ root, cacheDir: '.vite-cache', plugins: [redline({ root, plugins: [voice({ transcribe: fake, live: false })] })] });
