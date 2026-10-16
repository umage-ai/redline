import { defineConfig } from '@playwright/test';
import { FIXTURES, type Fixture } from './test/e2e/fixtures.ts';

// One dev server per fixture app (see test/e2e/fixtures.ts). Run `npm run build` first;
// `npm run test:e2e` does. Tests share each fixture's .redline/ folder, so run serially.
export default defineConfig({
  testDir: 'test/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // Installed Chrome by default; set PW_CHROMIUM=1 to use Playwright's bundled Chromium
    // (`npx playwright install chromium`), e.g. on CI.
    channel: process.env.PW_CHROMIUM ? undefined : 'chrome',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  // PW_FIXTURES=vue,angular starts only those servers (pair it with -g or a spec filter).
  webServer: Object.values(FIXTURES).filter((f: Fixture) => !process.env.PW_FIXTURES || process.env.PW_FIXTURES.split(',').includes(f.name)).map((f: Fixture) => ({
    command: f.command,
    cwd: f.dir,
    url: `${f.url}/__redline/config`,
    reuseExistingServer: !process.env.CI,
    timeout: f.timeout ?? 120_000,
    env: { ASTRO_TELEMETRY_DISABLED: '1' },
  })),
});
