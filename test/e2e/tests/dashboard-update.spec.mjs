import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { dashboardReleases } from "./sim.mjs";

const request = () => path.join(process.env.PADDOCK_E2E_DATA, "update-request.json");
const readRequest = () => JSON.parse(fs.readFileSync(request(), "utf8"));
const updater = (name) => path.join(process.env.PADDOCK_E2E_UPDATER, name);

test("a newer dashboard is offered with its notes, and an admin asks the updater for it", async ({ page }) => {
  // a stable release, so it counts whichever channel this dashboard follows
  const version = `99.${Date.now() % 1_000_000}.0`;
  await dashboardReleases([`v${version}`]);
  expect((await page.request.get("/api/dashboard-update?refresh=1")).ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("link", { name: /update available/ }).click();
  await expect(page).toHaveURL(/\/update$/);
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
  await expect(page.getByText(`Update available: ${version}`)).toBeVisible();
  await expect(page.getByText(`notes for v${version}`)).toBeVisible();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `Update to ${version}` }).click();
  await expect(page.getByText("Waiting for the updater to start")).toBeVisible();
  expect(readRequest().version).toBe(`v${version}`);

  // as llama-paddock-updater does when the new version doesn't come up
  const current = (await (await page.request.get("/api/dashboard-update")).json()).current;
  fs.rmSync(request());
  const now = Date.now() / 1000;
  fs.writeFileSync(updater("status.json"), JSON.stringify({
    state: "rolled_back", action: "update", version, from: current, started: now - 30, finished: now,
    message: "it didn't answer on /api/healthz within 2 minutes", by: "admin",
  }));
  await expect(page.getByText(`Update to ${version} failed. ${current} is back`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the channel, automatic updates and a rollback each go to the updater after confirming", async ({ page }) => {
  fs.writeFileSync(updater("channel"), "latest\n");
  // an earlier update whose pre-update backup is still kept
  const backup = "20261101T000000Z-v0.0.1-pre-update";
  const dir = path.join(process.env.PADDOCK_E2E_DATA, "backups", backup);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ format: 1, reason: "pre-update", app_version: "0.0.1", files: [] }));
  const now = Date.now() / 1000;
  fs.writeFileSync(updater("history.jsonl"), JSON.stringify({
    state: "done", action: "update", version: "0.0.2", from: "0.0.1", started: now - 3600, finished: now - 3500, backup, by: "admin",
  }) + "\n");

  await page.goto("/update");
  const auto = page.getByRole("switch", { name: "Automatic updates" });
  await expect(auto).toHaveAttribute("aria-checked", "false");
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "true");
  expect(readRequest()).toMatchObject({ action: "auto", enabled: true });
  fs.rmSync(request());
  fs.writeFileSync(updater("auto-update"), "on\n");

  await page.getByRole("button", { name: "Prerelease" }).click();
  const dialog = page.getByRole("dialog", { name: "Switch to prereleases?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Switch to prereleases" }).click();
  await expect(dialog).toBeHidden();
  expect(readRequest()).toMatchObject({ action: "channel", channel: "dev" });
  fs.rmSync(request());
  fs.rmSync(updater("status.json"), { force: true });
  await page.reload();

  await page.getByRole("button", { name: "Roll back to 0.0.1" }).click();
  const rb = page.getByRole("dialog", { name: "Roll back to 0.0.1?" });
  await expect(rb.getByText("Changes since then are lost")).toBeVisible();
  await rb.getByRole("button", { name: "Roll back to 0.0.1" }).click();
  await expect(rb).toBeHidden();
  expect(readRequest()).toMatchObject({ action: "rollback", version: "v0.0.1", backup });
  // the status tile, not the toast saying the same
  await expect(page.locator(".upd-big", { hasText: "Rolling back to 0.0.1" })).toBeVisible();

  // leave the page as the other tests expect it
  fs.rmSync(request());
  for (const f of ["history.jsonl", "auto-update", "channel"]) fs.rmSync(updater(f), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
