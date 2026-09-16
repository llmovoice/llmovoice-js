import { expect, test } from "@playwright/test";

test("text, topic switching, network orchestration, and trace are visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Long conversations.")).toBeVisible();

  await page.getByRole("button", { name: "Load topic-switch scenario" }).click();
  await expect(page.locator(".transcript-page")).toHaveCount(3);
  expect(await page.locator(".thread-card").count()).toBeGreaterThanOrEqual(2);

  const composer = page.getByPlaceholder("Send a text turn into the same context…");
  await composer.fill("Return to the Vancouver hotel and keep every original constraint.");
  await composer.press("Enter");
  await expect(page.locator(".transcript-page")).toHaveCount(4);

  await page.getByRole("button", { name: "Volatile" }).click();
  await expect(page.locator(".state-cell").filter({ hasText: "Connection" })).toContainText("degraded");
  await page.getByRole("button", { name: "Trace" }).click();
  await expect(page.locator(".trace-item").first()).toBeVisible();
});
