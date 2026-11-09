import { expect, test } from "@playwright/test";
import { agentReleases, hostState, scenario } from "./sim.mjs";

test("an outdated agent is flagged and updated from its host page", async ({ page }) => {
  const current = (await hostState("sim-1")).agent_version;
  // a stable release, so it counts whichever channel this dashboard follows
  const version = `9.${Date.now() % 1_000_000}.0`;
  await agentReleases([`v${current}`, `v${version}`]);
  expect((await page.request.get("/api/agent-releases?refresh=1")).ok()).toBe(true);

  await page.goto("/");
  await expect(page.getByText("2 agents are older than the latest release.")).toBeVisible();

  await page.goto("/i/sim-1/monitor");
  await expect(page.getByText(`Agent ${version} is out; this host runs ${current}.`)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Update agent" }).click();
  await expect(page.getByText(`The agent was updated from ${current} to ${version}.`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(`agent ${version}`, { exact: true })).toBeVisible();

  // leave the fleet current for the other tests
  await scenario("sim-2", { agent_version: version });
});
