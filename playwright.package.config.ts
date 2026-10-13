import { defineConfig } from '@playwright/test';
import { PACKAGE_APPS } from './test/package/apps.ts';

// Browser tests against the packed tarball installed into temp apps.
// Run through `npm run test:package`, which builds the apps and sets REDLINE_PKG_DIR.
export default defineConfig({
  testDir: 'test/package',
  outputDir: 'test-results/package',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    channel: process.env.PW_CHROMIUM ? undefined : 'chrome',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
  },
  webServer: Object.values(PACKAGE_APPS).map(a => ({
    command: a.command,
    cwd: a.dir,
    url: `${a.url}/__redline/config`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ASTRO_TELEMETRY_DISABLED: '1' },
  })),
});
