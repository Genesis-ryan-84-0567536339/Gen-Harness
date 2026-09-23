import { defineConfig, devices } from '@playwright/test';

/**
 * Chạy web với API thật (không mock). Cần: API ở :8000 trên CSDL MỚI (chưa thiết lập) với GH_SETUP_TOKEN,
 * GH_COOKIE_SECURE=false; rồi `npx vite --port 5173`. Chạy: `npx playwright test -c playwright.live.config.ts`.
 */
export default defineConfig({
  testDir: './e2e-live',
  outputDir: './test-results/live',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? 'http://localhost:5173',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: 'dark',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } }],
});
