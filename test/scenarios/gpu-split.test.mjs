// The GPU/CPU split of loaded models, as /api/instances reports it for the fleet overview, Monitor and
// Models tabs: fully on the GPU, partly offloaded to the CPU, all on the CPU, unknown when Ollama
// leaves the sizes out, and Ollama cloud models flagged in the model list.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

before(async () => {
  // one 24 GiB GPU, so a large context can't fit
  holder.stack = await startStack({ sim: { hosts: 1, gpus: "1", pullSeconds: 1 } });
  ({ client: c, sim } = holder.stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.ps.length, "online with a loaded model");
});
after(() => holder.stack?.stop());

const loaded = (inst, name) => inst.ps.find((m) => m.name === name);
/** Load a model the way a client of Ollama would, with options the dashboard's Load button doesn't send. */
async function generate(body) {
  const r = await fetch(`${sim.host("sim-1").ollama_url}/api/generate`, { method: "POST", body: JSON.stringify({ stream: false, ...body }) });
  assert.equal(r.status, 200, await r.text());
}

test("a model that fits is reported fully on the GPU", async () => {
  const m = loaded(await c.instance("sim-1"), "llama3.2:3b");
  assert.deepEqual(m.split, { state: "gpu", gpu_pct: 100, cpu_bytes: 0 });
});

test("a context too large for VRAM is reported as a partial split", async () => {
  // ~26 GB of KV cache on top of the weights: the rest spills into system RAM
  await generate({ model: "qwen2.5-coder:7b", options: { num_ctx: 200_000 } });
  const inst = await c.waitInstance("sim-1", (x) => loaded(x, "qwen2.5-coder:7b")?.context_length === 200_000, "the large context loaded");
  const m = loaded(inst, "qwen2.5-coder:7b");
  assert.equal(m.split.state, "partial", JSON.stringify(m));
  assert.ok(m.split.gpu_pct > 0 && m.split.gpu_pct < 100, `gpu_pct ${m.split.gpu_pct}`);
  assert.equal(m.split.gpu_pct, Math.round((m.size_vram / m.size) * 100));
  assert.equal(m.split.cpu_bytes, m.size - m.size_vram);
  // the other model is unaffected
  assert.equal(loaded(inst, "llama3.2:3b").split.state, "gpu");
});

test("num_gpu 0 is reported as all on the CPU", async () => {
  await generate({ model: "nomic-embed-text", options: { num_gpu: 0 } });
  const inst = await c.waitInstance("sim-1", (x) => loaded(x, "nomic-embed-text:latest"), "the embedding model loaded");
  const m = loaded(inst, "nomic-embed-text:latest");
  assert.deepEqual(m.split, { state: "cpu", gpu_pct: 0, cpu_bytes: m.size });
});

test("without size_vram the split is unknown, not 100% CPU", async () => {
  await sim.scenario("sim-1", { ps_size_vram: false });
  try {
    const inst = await c.waitInstance("sim-1", (x) => x.ps.length && x.ps.every((m) => m.size_vram === undefined), "sizes left out");
    for (const m of inst.ps) assert.deepEqual(m.split, { state: "unknown", gpu_pct: null, cpu_bytes: null }, m.name);
  } finally {
    await sim.scenario("sim-1", { ps_size_vram: true });
  }
  await c.waitInstance("sim-1", (x) => x.ps.every((m) => m.split.state !== "unknown"), "sizes back");
});

test("cloud models are flagged in the model list and take no local VRAM", async () => {
  const r = await c.post("/api/instances/sim-1/models/pull", { model: "gpt-oss:20b-cloud" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.waitJob(r.data.id, (j) => j.state === "done", "the cloud model's pull");

  const models = (await c.get("/api/instances/sim-1/models")).data.models;
  const cloud = models.find((m) => m.name === "gpt-oss:20b-cloud");
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.remote_host, "https://ollama.com:443");
  assert.ok(models.filter((m) => m.name !== cloud.name).every((m) => m.cloud === false), "local models aren't flagged");

  // using it loads nothing locally: Ollama forwards the request
  const r2 = await c.post("/api/instances/sim-1/models/load", { model: "gpt-oss:20b-cloud" });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const since = Date.now() / 1000;
  const inst = await c.waitInstance("sim-1", (x) => x.updated > since, "a poll after the request");
  assert.equal(loaded(inst, "gpt-oss:20b-cloud"), undefined);
});
