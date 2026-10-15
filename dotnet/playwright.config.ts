import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Browser smoke tests for the .NET integration: the Razor and Blazor samples on ports 5210/5211
// (dotnet run, Development). Uses the repo's Playwright: from the repo root,
//   npx playwright test -c dotnet/playwright.config.ts
// Notes go to <repo>/.redline/e2e-dotnet (gitignored with .redline).
const env = { ASPNETCORE_ENVIRONMENT: 'Development', Redline__Dir: '.redline/e2e-dotnet', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: '../test-results/dotnet',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    channel: process.env.PW_CHROMIUM ? undefined : 'chrome',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'dotnet run --project samples/RazorSample --no-launch-profile --urls http://localhost:5210', cwd: here, url: 'http://localhost:5210/__redline/config', reuseExistingServer: true, timeout: 240_000, env },
    { command: 'dotnet run --project samples/BlazorSample/BlazorSample --no-launch-profile --urls http://localhost:5211', cwd: here, url: 'http://localhost:5211/__redline/config', reuseExistingServer: true, timeout: 240_000, env },
  ],
});
