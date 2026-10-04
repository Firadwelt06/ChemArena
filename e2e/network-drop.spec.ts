import { expect, test } from "@playwright/test";

const username = process.env.CHEMARENA_E2E_USERNAME;
const password = process.env.CHEMARENA_E2E_PASSWORD;

test.skip(!username || !password, "Set CHEMARENA_E2E_USERNAME and CHEMARENA_E2E_PASSWORD for the disposable exam account.");
test.setTimeout(120_000);

test("keeps exam answers safe through a network drop and retries the frozen submission", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill(username!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Start / resume" }).first().click();
  await expect(page.getByText("READY TO BEGIN")).toBeVisible();
  await page.getByRole("button", { name: "Continue without full screen" }).click();

  await page.route("**/api/student/answers", (route) => route.abort("failed"));
  await page.locator(".cbt-option").first().click();
  await expect(page.getByText("Offline — answers safe on this device")).toBeVisible();
  await page.unroute("**/api/student/answers");
  await page.locator(".cbt-option").first().click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });

  await page.route("**/api/student/attempts/*/submit", (route) => route.abort("failed"));
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Submit exam" }).last().click();
  await expect(page.getByText("Your final answers are frozen on this device.")).toBeVisible();
  await page.unroute("**/api/student/attempts/*/submit");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading", { name: "Your result" })).toBeVisible({ timeout: 30_000 });
});
