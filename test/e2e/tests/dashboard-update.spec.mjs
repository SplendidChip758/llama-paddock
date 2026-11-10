import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { dashboardReleases } from "./sim.mjs";

test("a newer dashboard is offered with its notes, and an admin asks the updater for it", async ({ page }) => {
  // a stable release, so it counts whichever channel this dashboard follows
  const version = `99.${Date.now() % 1_000_000}.0`;
  await dashboardReleases([`v${version}`]);
  expect((await page.request.get("/api/dashboard-update?refresh=1")).ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("link", { name: /update available/ }).click();
  await expect(page).toHaveURL(/\/update$/);
  await expect(page.getByRole("heading", { name: `Update available: ${version}` })).toBeVisible();
  await expect(page.getByText(`notes for v${version}`)).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `Update to ${version}` }).click();
  await expect(page.getByText(`Waiting for the updater to start the update to ${version}`)).toBeVisible();
  const request = path.join(process.env.PADDOCK_E2E_DATA, "update-request.json");
  expect(JSON.parse(fs.readFileSync(request, "utf8")).version).toBe(`v${version}`);

  // as llama-paddock-updater does when the new version doesn't come up
  const current = (await (await page.request.get("/api/dashboard-update")).json()).current;
  fs.rmSync(request);
  const now = Date.now() / 1000;
  fs.writeFileSync(path.join(process.env.PADDOCK_E2E_UPDATER, "status.json"), JSON.stringify({
    state: "rolled_back", version, from: current, started: now - 30, finished: now,
    message: "it didn't answer on /api/healthz within 2 minutes", backup: "20261109T000000Z-pre-update",
  }));
  await expect(page.getByText(`The update to ${version} failed, and ${current} is back.`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: `Update to ${version}` })).toBeVisible();
});
