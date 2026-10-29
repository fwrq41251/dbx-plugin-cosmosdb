import { defineConfig } from "@playwright/test";
import { readRun } from "./tests/e2e-run.mjs";
const run = readRun();
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  outputDir: run.artifacts,
  use: {
    channel: process.env.CI ? undefined : "chrome",
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node tests/mock-cosmos.mjs",
      url: run.mockURL + "/health",
      reuseExistingServer: false,
      env: { COSMOS_E2E_MOCK_PORT: String(run.mockPort) },
    },
    {
      command: "node tests/start-dev.mjs",
      url: run.hostURL,
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        DBX_PLUGIN_DATA_DIR: run.pluginData,
        COSMOS_E2E_SDK_ROOT: run.sdkRoot,
      },
    },
  ],
});
