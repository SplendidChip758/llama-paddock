// Unavailable hosts: Ollama and the agent go away (and come back) independently, and the
// dashboard reports each one separately, in /api/instances and in /metrics.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { metric, scenarioTest, startStack } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

before(async () => {
  holder.stack = await startStack({ sim: { hosts: 2, gpus: "2,1" } });
  ({ client: c, sim } = holder.stack);
});
after(() => holder.stack?.stop());

const healthy = (i) => i.ollama_ok && i.agent_ok;
const metrics = async () => {
  const r = await c.get("/metrics");
  assert.equal(r.status, 200);
  return r.data;
};

test("every simulated host comes online with its GPUs and models", async () => {
  const one = await c.waitInstance("sim-1", healthy, "online");
  const two = await c.waitInstance("sim-2", healthy, "online");
  assert.equal(one.stats.nvidia.gpus.length, 2);
  assert.equal(two.stats.nvidia.gpus.length, 1);
  assert.equal(one.version, sim.host("sim-1").ollama_version);
  assert.equal(one.agent_version, sim.host("sim-1").agent_version);
  assert.ok(one.ps.length >= 1, "sim-1 starts with a loaded model");
  const models = await c.get("/api/instances/sim-1/models");
  assert.equal(models.status, 200);
  assert.ok(models.data.models.length >= 3);
});

test("Ollama down: reported unreachable, the agent still reports, metrics say 0", async () => {
  await sim.scenario("sim-1", { ollama: "down" });
  const i = await c.waitInstance("sim-1", (x) => !x.ollama_ok, "Ollama marked down");
  assert.match(i.ollama_error, /ollama unreachable: .*ECONNREFUSED/);
  assert.deepEqual(i.ps, [], "no loaded models are shown for an unreachable Ollama");
  await c.waitInstance("sim-1", (x) => x.agent_ok && x.stats.service.active === "failed", "agent still reporting");
  assert.ok((await c.instance("sim-2")).ollama_ok, "the other host is unaffected");

  const m = await metrics();
  assert.equal(metric(m, "paddock_ollama_up", { instance: "sim-1" }), 0);
  assert.equal(metric(m, "paddock_ollama_up", { instance: "sim-2" }), 1);
  assert.equal(metric(m, "paddock_agent_up", { instance: "sim-1" }), 1);
  assert.equal(metric(m, "paddock_ollama_loaded_models", { instance: "sim-1" }), undefined);

  const models = await c.get("/api/instances/sim-1/models");
  assert.equal(models.status, 502);
  assert.match(models.data.detail, /ollama unreachable/);
});

test("Ollama comes back", async () => {
  await sim.scenario("sim-1", { ollama: "up" });
  await c.waitInstance("sim-1", healthy, "Ollama back up");
  assert.equal(metric(await metrics(), "paddock_ollama_up", { instance: "sim-1" }), 1);
});

test("Ollama hangs: the poll times out instead of waiting forever", async () => {
  await sim.scenario("sim-2", { ollama: "hang" });
  const i = await c.waitInstance("sim-2", (x) => !x.ollama_ok, "Ollama timed out");
  assert.match(i.ollama_error, /timed out/);
  await sim.scenario("sim-2", { ollama: "up" });
  await c.waitInstance("sim-2", healthy, "Ollama answering again");
});

test("agent down with Ollama up: only the agent is reported down", async () => {
  await sim.scenario("sim-2", { agent: "down" });
  const i = await c.waitInstance("sim-2", (x) => !x.agent_ok, "agent marked down");
  assert.match(i.agent_error, /agent unreachable: .*ECONNREFUSED/);
  assert.ok(i.ollama_ok, "Ollama is still fine");

  const m = await metrics();
  assert.equal(metric(m, "paddock_agent_up", { instance: "sim-2" }), 0);
  assert.equal(metric(m, "paddock_ollama_up", { instance: "sim-2" }), 1);
  // the last stats are kept for the UI, but not presented to Prometheus as current
  assert.equal(metric(m, "paddock_gpu_utilization_ratio", { instance: "sim-2", gpu: 0 }), undefined);

  const logs = await c.get("/api/instances/sim-2/logs");
  assert.equal(logs.status, 502);
});

test("agent comes back", async () => {
  await sim.scenario("sim-2", { agent: "up" });
  await c.waitInstance("sim-2", healthy, "agent back up");
  const m = await metrics();
  assert.equal(metric(m, "paddock_agent_up", { instance: "sim-2" }), 1);
  assert.notEqual(metric(m, "paddock_gpu_utilization_ratio", { instance: "sim-2", gpu: 0 }), undefined);
});

test("both down at once, then both back", async () => {
  await sim.scenario("sim-1", { ollama: "down", agent: "down" });
  const i = await c.waitInstance("sim-1", (x) => !x.ollama_ok && !x.agent_ok, "both down");
  assert.ok(i.ollama_error && i.agent_error);
  await sim.scenario("sim-1", { ollama: "up", agent: "up" });
  await c.waitInstance("sim-1", healthy, "both back");
});
