// The model library (#30): search ollama.com's library through the dashboard, read a model's tags,
// and pull one. The simulator serves pages in ollama.com's markup, so this also checks the parsers.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

before(async () => {
  holder.stack = await startStack({
    sim: { hosts: 2, gpus: "1,1", pullSeconds: 1 },
    data: (s) => ({ extra: `model_registry_url: ${s.control}/registry\nmodel_library_url: ${s.control}/ollama.com` }),
  });
  ({ client: c, sim } = holder.stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok, "online");
});
after(() => holder.stack?.stop());

const get = async (p) => {
  const r = await c.get(p);
  assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.data)}`);
  return r.data;
};
const requests = async () => (await (await fetch(`${sim.control}/library-requests`)).json()).requests;

test("search lists models with their capabilities, sizes and pull counts, a page at a time", async () => {
  const first = await get("/api/library");
  assert.equal(first.models.length, 4);
  assert.equal(first.has_more, true);
  const qwen = first.models.find((m) => m.name === "qwen3");
  assert.deepEqual(qwen, {
    name: "qwen3", path: "library/qwen3", description: "Qwen3 is the latest generation of large language models in the Qwen series.",
    capabilities: ["tools", "thinking"], sizes: ["0.6b", "4b", "8b", "14b", "32b"], pulls: 42_600_000, tag_count: 21, updated: "October 1, 2025",
  });
  const second = await get("/api/library?page=2");
  assert.equal(second.has_more, false);
  assert.deepEqual([...first.models, ...second.models].map((m) => m.name).sort(),
    ["deepseek-r1", "gemma3", "gpt-oss", "llama3.2", "nomic-embed-text", "qwen3", "someone/tiny-coder"]);
});

test("search filters by text and capability, and sorts by newest", async () => {
  assert.deepEqual((await get("/api/library?q=qwen")).models.map((m) => m.name), ["qwen3"]);
  assert.deepEqual((await get("/api/library?capability=embedding")).models.map((m) => m.name), ["nomic-embed-text"]);
  const vision = (await get("/api/library?capability=vision")).models;
  assert.ok(vision.every((m) => m.capabilities.includes("vision")) && vision.length === 1, JSON.stringify(vision));
  assert.equal((await get("/api/library?sort=newest")).models[0].name, "someone/tiny-coder");
});

test("results are cached on the dashboard", async () => {
  const before = (await requests()).filter((p) => p === "/search?q=llama").length;
  await get("/api/library?q=llama");
  await get("/api/library?q=llama");
  assert.equal((await requests()).filter((p) => p === "/search?q=llama").length, before + 1);
});

test("a model's tags give sizes, context, input and quantization, with aliases resolved", async () => {
  const m = await get("/api/library/tags?model=qwen3");
  assert.equal(m.name, "qwen3");
  assert.deepEqual(m.capabilities, ["tools", "thinking"]);
  const tag = (t) => m.tags.find((x) => x.tag === t);
  assert.equal(tag("8b").name, "qwen3:8b");
  assert.equal(tag("8b").context, 40960);
  assert.deepEqual(tag("8b").input, ["text"]);
  // "8b" and "latest" name no quantization; they share a digest with 8b-q4_K_M
  assert.equal(tag("latest").digest, tag("8b-q4_K_M").digest);
  assert.equal(tag("latest").quantization, "q4_K_M");
  assert.equal(tag("8b").quantization, "q4_K_M");
  assert.equal(tag("8b-q8_0").quantization, "q8_0");
  assert.ok(tag("8b-fp16").size > tag("8b-q8_0").size && tag("8b-q8_0").size > tag("8b").size, JSON.stringify(m.tags.slice(0, 6)));

  const gemma = await get("/api/library/tags?model=library/gemma3");
  assert.deepEqual(gemma.tags[0].input, ["text", "image"]);
});

test("cloud tags are flagged and have no size", async () => {
  const m = await get("/api/library/tags?model=gpt-oss");
  const cloud = m.tags.filter((t) => t.cloud);
  assert.deepEqual(cloud.map((t) => t.tag), ["20b-cloud", "120b-cloud"]);
  assert.ok(cloud.every((t) => t.size === null));
  assert.ok(m.tags.filter((t) => !t.cloud).every((t) => t.size > 0));
});

test("community models use their user path", async () => {
  const m = await get("/api/library/tags?model=someone/tiny-coder");
  assert.equal(m.name, "someone/tiny-coder");
  assert.ok(m.tags.some((t) => t.name === "someone/tiny-coder:1.5b"), JSON.stringify(m.tags.map((t) => t.name)));
});

test("a tag from the library pulls like any model", async () => {
  const m = await get("/api/library/tags?model=llama3.2");
  const t = m.tags.find((x) => x.tag === "1b-q8_0");
  const r = await c.post("/api/instances/sim-1/models/pull", { model: t.name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const models = await waitFor(async () => {
    const d = (await c.get("/api/instances/sim-1/models")).data;
    return d.models.find((x) => x.name === "llama3.2:1b-q8_0") && d.models;
  }, { what: "the pulled model" });
  const pulled = models.find((x) => x.name === "llama3.2:1b-q8_0");
  // the site rounds to 0.1 GB
  assert.ok(Math.abs(pulled.size - t.size) <= 0.05e9, `${pulled.size} vs ${t.size}`);
  assert.equal(pulled.details.quantization_level, "Q8_0");
});

test("unknown models and bad parameters are refused", async () => {
  assert.equal((await c.get("/api/library/tags?model=nothing-here")).status, 404);
  for (const p of ["/api/library/tags", "/api/library/tags?model=a/b/c", "/api/library?capability=fast", "/api/library?sort=best", "/api/library?page=0"]) {
    const r = await c.get(p);
    assert.equal(r.status, 400, `${p}: ${JSON.stringify(r.data)}`);
  }
});

// ============================================================================ fit estimates for models that aren't pulled
const fit = async (host, body) => {
  const r = await c.post(`/api/instances/${host}/models/fit`, body);
  return r;
};

test("a model that isn't pulled is estimated from its registry", async () => {
  const r = await fit("sim-1", { model: "phi4:14b", num_ctx: 4096 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.source, "registry");
  const m = r.data.model;
  assert.ok(m.weights > 8.4e9 && m.weights < 8.7e9, `weights ${m.weights}`);
  assert.equal(m.layers, 32);
  assert.deepEqual(m.kv_heads, Array(32).fill(8));
  const e = r.data.estimates[0];
  assert.equal(e.instance, "sim-1");
  // 128 KiB of f16 cache per token, as for installed models
  assert.equal(e.kv, 4096 * 128 * 1024);
  assert.equal(e.verdict, "fits", e.summary);

  const missing = await fit("sim-1", { model: "missing-model:1b" });
  assert.equal(missing.status, 404, JSON.stringify(missing.data));
  assert.match(missing.data.detail, /isn't in the registry/);
});

test("a registry estimate is calibrated by another host that has the model loaded", async () => {
  // pulled on sim-1 by the test above; load it there so the poller measures it
  const name = "llama3.2:1b-q8_0";
  const load = await c.post("/api/instances/sim-1/models/load", { model: name });
  assert.equal(load.status, 200, JSON.stringify(load.data));
  const loaded = await c.waitInstance("sim-1", (x) => x.ps.find((m) => m.name === name), "loaded");
  const ps = loaded.ps.find((m) => m.name === name);
  const r = await waitFor(async () => {
    const x = await fit("sim-2", { model: name, num_ctx: ps.context_length });
    return x.status === 200 && x.data.estimates[0].calibration && x.data;
  }, { what: "a calibrated estimate on sim-2" });
  assert.equal(r.source, "registry");
  assert.equal(r.model.digest, ps.digest);
  const e = r.estimates[0];
  assert.equal(e.instance, "sim-2");
  assert.equal(e.calibration.kind, "measured");
  assert.equal(e.total, ps.size);
});
