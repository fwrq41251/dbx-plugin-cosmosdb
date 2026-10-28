import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node tests/mock-cosmos.mjs",
      url: "http://127.0.0.1:18081/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev -- --port 5191 --data-dir .dbx-dev/e2e-plugin-scope",
      url: "http://127.0.0.1:5191",
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
});
