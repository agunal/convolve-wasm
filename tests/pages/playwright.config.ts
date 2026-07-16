import { defineConfig, devices } from "@playwright/test";

const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173/convolve-wasm/",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: chromiumExecutable
          ? { executablePath: chromiumExecutable }
          : {},
      },
    },
  ],
  webServer: {
    command:
      "npm run preview -w @takana-labs/convolve-demo -- --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173/convolve-wasm/",
    env: {
      ...process.env,
      CONVOLVE_DEMO_BASE: "/convolve-wasm/",
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
