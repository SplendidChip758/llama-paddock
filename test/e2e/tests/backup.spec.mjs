import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { PASSWORD } from "../../scenarios/harness.mjs";

const PASSPHRASE = "correct horse battery";

test("an admin exports the configuration and previews importing it", async ({ page }, info) => {
  await page.goto("/");
  await page.locator(".accountmenu summary").click();
  await page.getByRole("link", { name: "Backup" }).click();
  await expect(page).toHaveURL(/\/backup$/);

  const exportCard = page.locator("form.card", { has: page.getByRole("heading", { name: "Export" }) });
  // the hint is inside the label, so the name starts with "Passphrase"
  await exportCard.getByLabel(/^Passphrase/).fill("too short");
  await exportCard.getByLabel("Confirm passphrase").fill("too short");
  await exportCard.getByLabel(/^Your password/).fill(PASSWORD);
  await exportCard.getByRole("button", { name: "Download export" }).click();
  await expect(exportCard.locator(".notice.bad")).toContainText("at least 12 characters");

  await exportCard.getByLabel(/^Passphrase/).fill(PASSPHRASE);
  await exportCard.getByLabel("Confirm passphrase").fill(PASSPHRASE);
  const download = page.waitForEvent("download");
  await exportCard.getByRole("button", { name: "Download export" }).click();
  const file = info.outputPath("export.json");
  await (await download).saveAs(file);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).encryption.cipher).toBe("aes-256-gcm");

  // importing it into the install it came from changes nothing, so there is nothing to import
  const importCard = page.locator(".card", { has: page.getByRole("heading", { name: "Import" }) });
  await importCard.getByLabel("Export file").setInputFiles(file);
  await importCard.getByLabel(/^Passphrase/).fill(PASSPHRASE);
  // the parts to import are hidden until asked for, and everything is imported meanwhile
  await expect(importCard.getByLabel("Users", { exact: true })).toBeHidden();
  await importCard.getByLabel("Choose what to import").check();
  await expect(importCard.getByLabel("Users", { exact: true })).toBeChecked();
  await importCard.getByLabel("Choose what to import").uncheck();
  await importCard.getByRole("button", { name: "Preview import" }).click();
  await expect(importCard.getByRole("row", { name: /admin \(admin\)/ })).toContainText("unchanged");
  await expect(importCard.getByText(/0 to add, 0 to replace/)).toBeVisible();
  await expect(importCard.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
});
