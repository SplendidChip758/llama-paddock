// The GPU check: Ollama losing the GPU while nvidia-smi still sees it is flagged with the likely
// cause and a fix, fires the gpu_lost alert, and resolves once a fix brings the GPU back. CPU
// placement that a Modelfile or setting asks for isn't flagged, and agents before 0.8.0, which have
// no /gpu-check, fall back to the end of /logs.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

const RULES = [{ id: "gpu", name: "GPU lost", kind: "gpu_lost", for_s: 1, clear_s: 1 }];

before(async () => {
  holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,1", pullSeconds: 1 } });
  ({ client: c, sim } = holder.stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok && x.ps.length, "online with a loaded model");
  await c.waitInstance("sim-2", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

const now = () => Date.now() / 1000;
const waitCheck = (id, pred, what) => c.waitInstance(id, (x) => x.gpu_check && pred(x.gpu_check), what);
const gpuAlert = async (instance) => (await c.get("/api/alerts")).data.active.find((a) => a.rule === "gpu" && a.instance === instance);
/** Load a model the way a client of Ollama would. */
async function generate(id, body) {
  const r = await fetch(`${sim.host(id).ollama_url}/api/generate`, { method: "POST", body: JSON.stringify({ stream: false, ...body }) });
  assert.equal(r.status, 200, await r.text());
}

test("a host whose models are on the GPU checks out, with the discovery from Ollama's log", async () => {
  const g = (await waitCheck("sim-1", (x) => x.checked_at, "the log read")).gpu_check;
  assert.equal(g.state, "ok", JSON.stringify(g));
  assert.match(g.summary, /llama3\.2:3b on the GPU/);
  assert.ok(g.log_lines.some((l) => /inference compute.*library=CUDA/.test(l)), g.log_lines.join("\n"));
  assert.deepEqual(g.causes, []);

  const rules = (await c.get("/api/alerts/rules")).data.rules;
  assert.equal(rules.find((r) => r.kind === "gpu_lost")?.enabled, true, "on by default");
});

test("losing the GPU is flagged with error 999 and a reload fix, and fires the alert", async () => {
  assert.equal((await c.put("/api/alerts/rules", { rules: RULES })).status, 200);
  await sim.scenario("sim-1", { gpu_lost: "uvm" });
  const g = (await waitCheck("sim-1", (x) => x.state === "lost" && x.causes.some((y) => /error 999/.test(y)), "GPU lost with its cause")).gpu_check;
  assert.match(g.summary, /entirely on the CPU while nvidia-smi sees GPU0/);
  assert.equal(g.fixes[0].action, "reload_uvm", JSON.stringify(g.fixes));
  assert.equal(g.fixes.at(-1).action, "restart");
  assert.ok(g.log_lines.some((l) => /999/.test(l)));

  // the detail follows the check: the cause once the log has been read again
  let a;
  await waitFor(async () => (a = await gpuAlert("sim-1"))?.state === "firing" && /Likely cause: CUDA failed with error 999/.test(a.detail), {
    what: "the gpu_lost alert firing with its cause", describe: () => a,
  });
});

test("a restart that doesn't bring the GPU back is told from the new run's log", async () => {
  const r = await c.post("/api/instances/sim-1/gpu-check/fix", { action: "restart" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  // nothing is loaded after the restart, so only the log can tell
  const g = (await waitCheck("sim-1", (x) => x.state === "lost" && /found no compatible GPU/.test(x.summary), "the new run's discovery")).gpu_check;
  assert.ok(g.log_lines.some((l) => /no compatible GPUs were discovered/.test(l)));
  assert.equal((await gpuAlert("sim-1"))?.state, "firing", "still firing");
});

test("reloading nvidia_uvm brings the GPU back and resolves the alert", async () => {
  const since = now();
  const r = await c.post("/api/instances/sim-1/gpu-check/fix", { action: "reload_uvm" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  await waitCheck("sim-1", (x) => x.state === "ok" && /found the GPU when it started/.test(x.summary), "the GPU found again");
  await generate("sim-1", { model: "llama3.2:3b" });
  await waitCheck("sim-1", (x) => x.state === "ok" && /llama3\.2:3b on the GPU/.test(x.summary), "the model on the GPU again");
  await waitFor(async () => {
    const t = (await c.get("/api/alerts/transitions?limit=1000")).data.transitions;
    return t.find((x) => x.rule === "gpu" && x.instance === "sim-1" && x.state === "resolved" && x.t > since);
  }, { what: "the gpu_lost alert resolved" });

  const bad = await c.post("/api/instances/sim-1/gpu-check/fix", { action: "rm -rf" });
  assert.equal(bad.status, 400);
});

test("a Modelfile that asks for the CPU isn't flagged", async () => {
  const r = await c.post("/api/instances/sim-2/models/create", { model: "embed-cpu", from: "nomic-embed-text", parameters: { num_gpu: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.waitJob(r.data.id, (j) => j.state === "done", "the create");
  await generate("sim-2", { model: "embed-cpu" });
  const g = (await waitCheck("sim-2", (x) => x.state === "cpu_intended", "CPU on purpose")).gpu_check;
  assert.match(g.summary, /embed-cpu:latest sets num_gpu 0 in its Modelfile/);
  // a few polls later, still no alert
  const since = now();
  await c.waitInstance("sim-2", (x) => x.updated > since + 2, "a few more polls");
  assert.equal(await gpuAlert("sim-2"), undefined);
});

test("CUDA_VISIBLE_DEVICES=-1 counts as CPU on purpose", async () => {
  await sim.scenario("sim-2", { gpu_lost: "restart" });
  await generate("sim-2", { model: "llama3.2:3b" });
  await waitCheck("sim-2", (x) => x.state === "lost", "the GPU lost");
  const env = await c.put("/api/instances/sim-2/env", { vars: { OLLAMA_HOST: "0.0.0.0:11434", CUDA_VISIBLE_DEVICES: "-1" }, restart: false });
  assert.equal(env.status, 200, JSON.stringify(env.data));
  const r = await c.post("/api/instances/sim-2/gpu-check");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.check.state, "cpu_intended", JSON.stringify(r.data.check));
  assert.match(r.data.check.summary, /CUDA_VISIBLE_DEVICES=-1/);
  await c.put("/api/instances/sim-2/env", { vars: { OLLAMA_HOST: "0.0.0.0:11434" }, restart: false });
});

test("an agent before 0.8.0 falls back to the end of /logs", async () => {
  await sim.scenario("sim-2", { agent_version: "0.7.0" });
  const r = await c.post("/api/instances/sim-2/gpu-check");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const g = r.data.check;
  assert.equal(g.state, "lost", JSON.stringify(g));
  assert.ok(g.notes.some((n) => /older than 0\.8\.0/.test(n)), JSON.stringify(g.notes));
  assert.ok(g.causes.some((y) => /error 999/.test(y)), "the cause, from /logs");
  // without the agent's nvidia_uvm state, restarting is the fix it can offer
  assert.deepEqual(g.fixes.map((f) => f.action), ["restart"]);

  const fix = await c.post("/api/instances/sim-2/gpu-check/fix", { action: "restart" });
  assert.equal(fix.status, 200, JSON.stringify(fix.data));
  await generate("sim-2", { model: "llama3.2:3b" });
  await waitCheck("sim-2", (x) => x.state === "ok", "the GPU back after the restart");
});
