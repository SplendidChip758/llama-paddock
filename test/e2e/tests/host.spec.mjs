import { expect, test } from "@playwright/test";

const TABS = ["Monitor", "Models", "Environment", "Logs", "Requests", "Diagnostics"];

test("every host tab opens without an error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/i/sim-1/monitor");
  const tabs = page.locator("nav.tabs");
  for (const name of TABS) {
    await tabs.getByRole("link", { name, exact: true }).click();
    await expect(tabs.getByRole("link", { name, exact: true })).toHaveClass(/active/);
    await expect(page.getByRole("heading", { level: 1, name: "sim-1" })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("pulling a model from the Models tab adds it to the list", async ({ page }) => {
  await page.goto("/i/sim-2/models");
  // a new name each time, so a retry or --repeat-each doesn't find it already pulled
  const model = `smollm2:e2e-${Date.now().toString(36)}`;
  const names = page.locator("table tbody td .name");
  await expect(names.first()).toBeVisible();
  const before = await names.count();
  await expect(names.filter({ hasText: model })).toHaveCount(0);

  await page.getByPlaceholder(/qwen3:8b/).fill(model);
  await page.getByRole("button", { name: "Pull", exact: true }).click();

  // the simulator takes two seconds per pull; the list refreshes when the job finishes
  await expect(names.filter({ hasText: model })).toHaveCount(1, { timeout: 30_000 });
  await expect(names).toHaveCount(before + 1);
});
