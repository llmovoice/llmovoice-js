import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const demoEnvFile = resolve(process.cwd(), "apps/demo/.env.local");
if (existsSync(demoEnvFile)) loadEnvFile(demoEnvFile);

const externalBaseUrl = process.env.LLMOVOICE_E2E_BASE_URL;
const realMode = process.env.LLMOVOICE_E2E_REAL === "1";
const realCredentialsReady = Boolean(process.env.LLMOVOICE_E2E_EMAIL && process.env.LLMOVOICE_E2E_PASSWORD);
const shouldStartServer = !externalBaseUrl && (!realMode || realCredentialsReady);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: externalBaseUrl ?? "http://localhost:3107",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    permissions: ["microphone"],
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    },
  }],
  webServer: shouldStartServer ? {
    command: "pnpm build:packages && pnpm --filter @llmovoice/demo dev --port 3107",
    url: "http://localhost:3107",
    ...(!realMode ? {
      env: {
        NEXT_PUBLIC_SUPABASE_URL: "",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      },
    } : {}),
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  } : undefined,
});
