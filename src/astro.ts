// Astro integration: adds the Vite plugin during `astro dev` only.
//
//   import redline from '@umage.ai/redline/astro'
//   export default defineConfig({ integrations: [redline()] })

import redlineVite, { type RedlineViteOptions } from './vite.ts';

export default function redline(options: RedlineViteOptions = {}) {
  return {
    name: 'redline',
    hooks: {
      'astro:config:setup': ({ command, updateConfig }: { command: string; updateConfig: (c: unknown) => void }) => {
        if (command !== 'dev') return;
        updateConfig({ vite: { plugins: [redlineVite(options)] } });
      },
    },
  };
}

export { redline };
