// The library's fit filter (#33): estimate library tags on a chosen host, GPU and context without
// pulling them, share one model header among a size's quantizations, and match a tag to the
// benchmarks of the same model build.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

before(async () => {
  // sim-1: two 24 GiB GPUs
  holder.stack = await startStack({
    sim: { hosts: 1, gpus: "2", pullSeconds: 1 },
    data: (s) => ({ extra: `model_registry_url: ${s.control}/registry\nmodel_library_url: ${s.control}/ollama.com` }),
  });
  ({ client: c, sim } = holder.stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok && x.stats?.nvidia.gpus.length === 2, "online with two GPUs");
});
after(() => holder.stack?.stop());

const fit = async (body) => {
  const r = await c.post("/api/instances/sim-1/models/fit", body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.estimates[0];
};
const weightReads = async () => (await (await fetch(`${sim.control}/library-requests`)).json()).requests.filter((r) => r.startsWith("weights "));

test("library tags are estimated at a context without being pulled", async () => {
  const tags = (await c.get("/api/library/tags?model=qwen3")).data.tags;
  const small = await fit({ model: tags.find((t) => t.tag === "8b").name, num_ctx: 8192 });
  assert.equal(small.verdict, "fits", small.summary);
  // 32B in fp16 is about 64 GB: more than both GPUs
  const big = await fit({ model: tags.find((t) => t.tag === "32b-fp16").name, num_ctx: 8192 });
  assert.ok(["offload", "insufficient"].includes(big.verdict), big.summary);
  assert.ok(!(await c.get("/api/instances/sim-1/models")).data.models.some((m) => m.name.startsWith("qwen3")), "nothing was pulled");
});

test("one GPU instead of both: a model that needs two no longer fits", async () => {
  // 32B in q8_0 is about 34 GB: it fits across two 24 GiB GPUs, not on one
  const both = await fit({ model: "qwen3:32b-q8_0", num_ctx: 4096 });
  assert.equal(both.verdict, "fits", both.summary);
  const one = await fit({ model: "qwen3:32b-q8_0", num_ctx: 4096, gpu: 1 });
  assert.equal(one.verdict, "offload", one.summary);
  assert.ok(one.gpu_pct > 0 && one.gpu_pct < 100, `gpu_pct ${one.gpu_pct}`);
  const bad = await c.post("/api/instances/sim-1/models/fit", { model: "qwen3:32b-q8_0", gpu: 7 });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
});

test("the quantizations of one size share a single read of the model header", async () => {
  const before = (await weightReads()).filter((r) => r.includes("qwen3:14b")).length;
  for (const tag of ["14b-q4_K_M", "14b-q8_0", "14b-fp16", "14b"]) {
    const e = await fit({ model: `qwen3:${tag}`, num_ctx: 4096 });
    assert.notEqual(e.verdict, "unknown", `${tag}: ${e.summary}`);
  }
  const reads = (await weightReads()).filter((r) => r.includes("qwen3:14b"));
  // a header read is one or two Range requests, all for the first tag asked
  assert.ok(reads.length - before >= 1 && reads.slice(before).every((r) => r.startsWith("weights qwen3:14b-q4_K_M ")), JSON.stringify(reads.slice(before)));
});

test("a library tag and a benchmark of the same build share a digest, so measured speed can be shown", async () => {
  const tags = (await c.get("/api/library/tags?model=llama3.2")).data.tags;
  const tag = tags.find((t) => t.tag === "1b-q8_0");
  const pull = await c.post("/api/instances/sim-1/models/pull", { model: tag.name });
  assert.equal(pull.status, 200, JSON.stringify(pull.data));
  await waitFor(async () => (await c.get("/api/instances/sim-1/models")).data.models.some((m) => m.name === tag.name), { what: "the pull" });
  const start = await c.post("/api/benchmarks", { model: tag.name, instances: ["sim-1"], num_ctx: 512, repeat: 1, cases: ["short"] });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const b = await waitFor(async () => {
    const list = (await c.get(`/api/benchmarks?instance=sim-1&model=${encodeURIComponent(tag.name)}`)).data.benchmarks;
    return list.find((x) => x.state === "done");
  }, { what: "the benchmark", timeout: 60_000 });
  assert.equal(b.conditions.digest.replace(/^sha256:/, "").slice(0, 12), tag.digest);
  assert.ok(b.summary.find((x) => x.case === "short").tps.median > 0);
});
