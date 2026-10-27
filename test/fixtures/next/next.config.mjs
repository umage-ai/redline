import { fileURLToPath } from 'node:url';
import { withRedline } from '@umage.ai/redline/next';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../..', import.meta.url));
// distDir: serve.mjs runs this app twice (webpack and Turbopack). The repo as the workspace root:
// @umage.ai/redline is linked from there (file:../../..), and Turbopack reads nothing outside it.
export default withRedline({
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  outputFileTracingRoot: repo,
  turbopack: { root: repo },
}, { root, directEdit: true });
