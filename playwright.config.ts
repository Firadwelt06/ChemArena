import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.CHEMARENA_E2E_URL ?? "http://127.0.0.1:4174",
    browserName: "chromium"
  }
});
