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
  let dashboard;
  try {
    dashboard = await startDashboard(data);
  } catch (e) {
    await sim.stop();
    data.remove();
    throw e;
  }
  fs.rmSync(path.join(HERE, ".auth"), { recursive: true, force: true });

  process.env.PADDOCK_E2E_URL = dashboard.url;
  process.env.PADDOCK_E2E_SIM = sim.control;

  return async () => {
    await Promise.allSettled([dashboard.stop(), sim.stop()]);
    data.remove();
  };
}
