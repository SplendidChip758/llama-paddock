// Starts the simulator and the built dashboard once for the whole run, with the scenario harness
// (test/scenarios/harness.mjs), so the browser tests and the scenario tests see the same stack.
// Nobody signs in here: the setup project does that in the browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDataDir, startDashboard, startSim } from "../scenarios/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  // two hosts, one with two GPUs and one with none, so the cards show both cases
  const sim = await startSim({ hosts: 2, gpus: "2,0", pullSeconds: 2 });
  // agents that can update themselves, whether or not the one in test/agent-release can
  for (const h of sim.hosts) await sim.scenario(h.id, { agent_update: "normal" });
  const data = makeDataDir(sim);
  // an installer install, so the dashboard update page offers its button; the tests play the updater
  const updater = path.join(data.dir, "updater");
  fs.mkdirSync(updater);
  let dashboard;
  try {
    dashboard = await startDashboard(data, { env: { PADDOCK_INSTALL_METHOD: "installer", PADDOCK_UPDATER_DIR: updater } });
  } catch (e) {
    await sim.stop();
    data.remove();
    throw e;
  }
  fs.rmSync(path.join(HERE, ".auth"), { recursive: true, force: true });

  process.env.PADDOCK_E2E_URL = dashboard.url;
  process.env.PADDOCK_E2E_SIM = sim.control;
  process.env.PADDOCK_E2E_DATA = data.data;
  process.env.PADDOCK_E2E_UPDATER = updater;

  return async () => {
    await Promise.allSettled([dashboard.stop(), sim.stop()]);
    data.remove();
  };
}
