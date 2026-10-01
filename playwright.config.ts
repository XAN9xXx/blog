import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'browser.spec.ts', workers: 1, retries: 0,
  reporter: 'list', outputDir: process.env.BLOG_TEST_OUTPUT ?? 'test-results',
  use: { baseURL: process.env.BLOG_TEST_URL ?? 'http://127.0.0.1:4321',
    viewport: { width: 1440, height: 1100 }, headless: true,
    channel: process.env.BLOG_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : undefined),
    // Avoid GPU contention in the isolated Windows headless verification process.
    launchOptions: { args: process.platform === 'win32' ? ['--disable-gpu'] : [] },
    screenshot: 'only-on-failure' },
});
