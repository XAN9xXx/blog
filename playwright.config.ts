import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'browser.spec.ts', workers: 1, retries: 0,
  reporter: 'list', outputDir: process.env.BLOG_TEST_OUTPUT ?? 'test-results',
  use: { baseURL: process.env.BLOG_TEST_URL ?? 'http://127.0.0.1:4321',
    viewport: { width: 1440, height: 1100 }, headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    screenshot: 'only-on-failure' },
});
