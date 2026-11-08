// The first sign-in, as a new user does it: the initial password, then the forced change. The session
// is saved for the other tests, so this runs once per run, against a fresh data dir.
import { expect, test as setup } from "@playwright/test";
import { INITIAL_PASSWORD, PASSWORD, USERNAME } from "../../scenarios/harness.mjs";

setup("first sign-in forces a password change", async ({ page }, info) => {
  // a retry or --repeat-each finds the password already changed: sign in with the new one
  const first = info.retry === 0 && info.repeatEachIndex === 0;

  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(first ? INITIAL_PASSWORD : PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  if (first) {
    await expect(page).toHaveURL(/\/change-password$/);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    // the hint is inside the label, so the name is "New password At least 8 characters."
    await page.getByLabel(/^New password/).fill(PASSWORD);
    await page.getByLabel("Confirm new password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Set password and continue" }).click();
  }

  await expect(page.getByRole("heading", { name: "Fleet overview" })).toBeVisible();
  await page.context().storageState({ path: ".auth/admin.json" });
});
