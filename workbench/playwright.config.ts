import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '../tests', testMatch: 'workbench-browser.spec.ts', workers: 1, retries: 0, reporter: 'list',
  outputDir: process.env.WORKBENCH_TEST_OUTPUT ?? '../test-results/workbench',
  use: { baseURL: process.env.WORKBENCH_TEST_URL ?? 'http://127.0.0.1:4325', viewport: { width: 1486, height: 1080 }, headless: true,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
    launchOptions: { args: process.platform === 'win32' ? ['--disable-gpu'] : [] }, screenshot: 'only-on-failure' },
});
