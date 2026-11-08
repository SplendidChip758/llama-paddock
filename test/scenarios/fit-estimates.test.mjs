// Fit estimates: weights + KV cache + buffers at a context, placed on each host's GPUs (or the CPU),
// with the largest context that stays in VRAM, the assumptions behind it, and calibration against
// the sizes /api/ps reported for the same model under the same settings.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

/** The simulator's models: 32 layers × 8 KV heads × (128 + 128) dims, at 2 bytes per f16 element */
const KV_PER_TOKEN = 32 * 8 * 256 * 2;

before(async () => {
  // sim-1 has one 24 GiB GPU, sim-2 none
  holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,0", pullSeconds: 1 } });
  ({ client: c, sim } = holder.stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok && x.ps.length, "online with a loaded model");
  await c.waitInstance("sim-2", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

async function fit(model, num_ctx, until = () => true, what = "the fit estimate") {
  let last;
  await waitFor(async () => {
    const r = await c.post("/api/instances/sim-1/models/fit", { model, ...(num_ctx ? { num_ctx } : {}) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    last = r.data;
    return until(last);
  }, { what, describe: () => JSON.stringify(last?.estimates, null, 1) });
  return last;
}
const known = (d) => d.hosts.every((h) => h.env !== null);
async function setEnv(id, vars) {
  const r = await c.put(`/api/instances/${id}/env`, { vars: { OLLAMA_HOST: "0.0.0.0:11434", ...vars }, restart: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function generate(id, body) {
  const r = await fetch(`${sim.host(id).ollama_url}/api/generate`, { method: "POST", body: JSON.stringify({ stream: false, ...body }) });
  assert.equal(r.status, 200, await r.text());
}

test("a small model fits on the GPU, with the KV cache from the model's shape and the largest context that fits", async () => {
  const d = await fit("llama3.2:3b", 8192, known, "the hosts' environments read");
  assert.equal(d.model.layers, 32);
  const [e, cpu] = d.estimates;
  assert.equal(e.instance, "sim-1");
  assert.equal(e.context, 8192);
  assert.equal(e.context_source, "requested");
  assert.equal(e.verdict, "fits", e.summary);
  assert.equal(e.gpu_pct, 100);
  assert.match(e.placement, /^GPU 0 \(NVIDIA GeForce RTX 3090\)$/);
  // flash attention isn't set, so the cache is f16 and the assumption says so
  assert.equal(e.kv, 8192 * KV_PER_TOKEN);
  assert.equal(e.weights, d.model.weights);
  assert.ok(e.overhead > 0);
  assert.ok(e.assumptions.some((a) => /OLLAMA_FLASH_ATTENTION isn't set/.test(a)), e.assumptions.join("\n"));
  assert.ok(e.max_gpu_context > 8192 && e.max_gpu_context <= 131072, `max ${e.max_gpu_context}`);

  // the host without a GPU runs it on the CPU, so there's no largest GPU context
  assert.equal(cpu.instance, "sim-2");
  assert.equal(cpu.verdict, "offload");
  assert.equal(cpu.gpu_pct, 0);
  assert.match(cpu.summary, /on the CPU \(no GPU reported\)/);
  assert.equal(cpu.max_gpu_context, null);
});

test("the estimate calibrates against what /api/ps reported: measured at that context, fitted between two", async () => {
  const ps = (await c.instance("sim-1")).ps.find((m) => m.name === "llama3.2:3b");
  const d = await fit("llama3.2:3b", ps.context_length, (x) => x.estimates[0].calibration?.kind === "measured", "the loaded size recorded");
  const e = d.estimates[0];
  assert.equal(e.total, ps.size);
  assert.equal(e.confidence, "high");
  assert.ok(e.formula_total > e.total, "the simulator charges no buffers, so the formula is above the measurement");

  await generate("sim-1", { model: "llama3.2:3b", options: { num_ctx: 16384 } });
  const d2 = await fit("llama3.2:3b", 32768, (x) => x.estimates[0].calibration?.kind === "fitted", "a second context recorded");
  const e2 = d2.estimates[0];
  // the simulator's size is linear in the context, so the line through two readings is exact
  assert.equal(e2.total, d2.model.weights + 32768 * KV_PER_TOKEN);
  assert.equal(e2.confidence, "medium", "extrapolated beyond the measured contexts");
  assert.ok(e2.assumptions[0].startsWith("Calibrated against what /api/ps reported at"), e2.assumptions[0]);
  const inside = (await fit("llama3.2:3b", 8192)).estimates[0];
  assert.equal(inside.confidence, "high");
});

test("the host's settings change the KV cache: quantized with flash attention, multiplied by parallel requests", async () => {
  await setEnv("sim-1", { OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0" });
  let d = await fit("qwen2.5-coder:7b", 8192, (x) => x.hosts[0].env?.kv_cache_type === "q8_0", "the new environment read");
  assert.equal(d.estimates[0].kv, Math.round(8192 * 32 * 8 * 256 * (34 / 32)));
  assert.ok(d.estimates[0].assumptions.includes("KV cache quantized to q8_0."));

  // 8 contexts of 32k don't fit in 24 GiB: part goes to system RAM
  await setEnv("sim-1", { OLLAMA_NUM_PARALLEL: "8" });
  d = await fit("qwen2.5-coder:7b", 32768, (x) => x.hosts[0].env?.num_parallel === 8, "OLLAMA_NUM_PARALLEL read");
  let e = d.estimates[0];
  assert.equal(e.kv, 8 * 32768 * KV_PER_TOKEN);
  assert.equal(e.verdict, "offload", e.summary);
  assert.ok(e.gpu_pct > 0 && e.gpu_pct < 100, `gpu_pct ${e.gpu_pct}`);
  assert.match(e.summary, /^Likely partly on the CPU/);
  assert.ok(e.max_gpu_context > 0 && e.max_gpu_context < 32768, `max ${e.max_gpu_context}`);
  // the largest context it reports does fit
  assert.equal((await fit("qwen2.5-coder:7b", e.max_gpu_context)).estimates[0].verdict, "fits");

  // and 64 of them don't fit in VRAM and RAM together
  await setEnv("sim-1", { OLLAMA_NUM_PARALLEL: "64" });
  d = await fit("qwen2.5-coder:7b", 32768, (x) => x.hosts[0].env?.num_parallel === 64, "OLLAMA_NUM_PARALLEL read");
  e = d.estimates[0];
  assert.equal(e.verdict, "insufficient", e.summary);
  assert.match(e.summary, /^Insufficient capacity/);
  await setEnv("sim-1", {});
});

test("cloud models aren't estimated, and a bad context is refused", async () => {
  const r = await c.post("/api/instances/sim-1/models/pull", { model: "gpt-oss:20b-cloud" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.waitJob(r.data.id, (j) => j.state === "done", "the cloud model's pull");
  const d = await fit("gpt-oss:20b-cloud");
  assert.ok(d.estimates.every((e) => e.verdict === "cloud" && e.total === null));

  const bad = await c.post("/api/instances/sim-1/models/fit", { model: "llama3.2:3b", num_ctx: -5 });
  assert.equal(bad.status, 400);
});
