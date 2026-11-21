import { expect, test } from "@playwright/test";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// The dashboard can't write to paddock.db while this test holds its write lock, as another process would
test("a database that refuses writes is shown on every page until saving works again", async ({ page }) => {
  await page.goto("/");
  const notice = page.getByRole("alert").filter({ hasText: "The dashboard can't save to its database" });
  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await expect(notice).toHaveCount(0);

  const lock = new DatabaseSync(path.join(process.env.PADDOCK_E2E_DATA, "paddock.db"));
  try {
    lock.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(notice.getByText(/Metric history, failing since .* ago: charts have a gap/)).toBeVisible();
    // on another page too
    await page.getByRole("link", { name: "Alerts" }).first().click();
    await expect(notice).toBeVisible();
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  await expect(notice).toHaveCount(0, { timeout: 30_000 });
});
