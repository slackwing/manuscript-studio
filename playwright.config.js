// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright config for Manuscript Studio.
 * Tests assume a running server at http://localhost:5001 — start it with
 * `make dev` (or `make dev-install` for Docker-packaged flow) in another
 * terminal before running tests.
 */
module.exports = defineConfig({
  testDir: './tests',

  // Only pick up .spec.js files; our standalone test-*.js files are run
  // directly via node, not by Playwright's test runner.
  testMatch: /.*\.spec\.js$/,

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }]
  ],

  use: {
    baseURL: 'http://localhost:5001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
