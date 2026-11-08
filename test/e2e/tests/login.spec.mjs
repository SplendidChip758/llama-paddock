import { expect, test } from "@playwright/test";
import { PASSWORD, USERNAME } from "../../scenarios/harness.mjs";

// signed out: these start without the saved session
test.use({ storageState: { cookies: [], origins: [] } });

test("a signed-out deep link goes to the login and back", async ({ page }) => {
  await page.goto("/i/sim-2/models");
  await expect(page).toHaveURL(/\/login\?next=%2Fi%2Fsim-2%2Fmodels$/);

  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/i\/sim-2\/models$/);
  await expect(page.getByRole("heading", { name: "Pull a model" })).toBeVisible();
});

test("a wrong password shows an error and stays on the login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.locator(".notice.bad")).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});
