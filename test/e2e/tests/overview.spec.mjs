import { expect, test } from "@playwright/test";
import { scenario } from "./sim.mjs";

const card = (page, name) => page.locator(".inst-card").filter({ has: page.getByRole("heading", { name, exact: true }) });

test("the overview shows every host with its GPUs and loaded models", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();

  const one = card(page, "sim-1");
  const two = card(page, "sim-2");
  await expect(one).toBeVisible();
  await expect(two).toBeVisible();

  // sim-1 has two GPUs and llama3.2:3b loaded; sim-2 has no GPUs and nothing loaded
  await expect(one.getByText(/^GPU0 · /)).toBeVisible();
  await expect(one.getByText(/^GPU1 · /)).toBeVisible();
  await expect(one.getByText("llama3.2:3b")).toBeVisible();
  await expect(two.getByText(/^GPU\d · /)).toHaveCount(0);
  await expect(two.getByText("No models loaded")).toBeVisible();

  // the header lists the hosts too
  await expect(page.locator("nav.instnav").getByRole("link", { name: "sim-2" })).toBeVisible();
});

test("a host that goes down is shown as down, and recovers", async ({ page }) => {
  await page.goto("/");
  const two = card(page, "sim-2");
  await expect(two.locator(".dot.ok")).toBeVisible();

  await scenario("sim-2", { ollama: "down" });
  try {
    await expect(two.locator(".dot.bad")).toBeVisible({ timeout: 30_000 });
  } finally {
    await scenario("sim-2", { ollama: "up" });
  }
  await expect(two.locator(".dot.ok")).toBeVisible({ timeout: 30_000 });
});

test("clicking a card opens the host", async ({ page }) => {
  await page.goto("/");
  await card(page, "sim-1").click();
  await expect(page).toHaveURL(/\/i\/sim-1\/monitor$/);
  await expect(page.getByRole("heading", { level: 1, name: "sim-1" })).toBeVisible();
});
