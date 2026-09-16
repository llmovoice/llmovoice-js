import { expect, test } from "@playwright/test";

const enabled = process.env.LLMOVOICE_E2E_REAL === "1";
const email = process.env.LLMOVOICE_E2E_EMAIL ?? "";
const password = process.env.LLMOVOICE_E2E_PASSWORD ?? "";

test.describe("real Supabase + OpenAI vertical path", () => {
  test.skip(!enabled || !email || !password, "Set LLMOVOICE_E2E_EMAIL/PASSWORD and server credentials to run the real E2E.");
  test.setTimeout(120_000);

  test("login, call, text, topic switch, reconnect, restore, and sign out", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("authenticated-user")).toBeVisible();

    await page.getByRole("button", { name: "Start live call" }).click();
    await expect(page.getByText("Realtime connected")).toBeVisible({ timeout: 30_000 });
    const composer = page.getByPlaceholder("Send a text turn into the same context…");
    await composer.fill("My current goal is to prepare a product launch.");
    await composer.press("Enter");
    await expect(page.getByText("My current goal is to prepare a product launch.", { exact: true })).toBeVisible();
    await composer.fill("Switch topics: plan a dog-friendly Vancouver hotel under $200.");
    await composer.press("Enter");
    await expect(page.getByText("Switch topics: plan a dog-friendly Vancouver hotel under $200.", { exact: true })).toBeVisible();

    const activeThread = page.locator(".thread-card.active").first();
    await expect(activeThread).toBeVisible();
    const activeTitle = await activeThread.locator(".thread-heading strong").innerText();
    await page.getByRole("button", { name: "End call" }).click();
    await page.getByRole("button", { name: "Start live call" }).click();
    await expect(page.getByText("Realtime connected")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "End call" }).click();

    await page.reload();
    await expect(page.getByTestId("authenticated-user")).toBeVisible();
    await expect(page.locator(".thread-card", { hasText: activeTitle })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByTestId("supabase-auth-form")).toBeVisible();
  });
});
