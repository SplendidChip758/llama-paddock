// Benchmarks (#32): repeated runs of a fixed prompt set, saved in paddock.db with the conditions they
// ran under (model digest, context, versions, cold or warm), so two hosts can be compared. Results
// survive a restart; one cut off by it is marked interrupted and keeps the runs it finished.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { Client, scenarioTest, startDashboard, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;
// a small context keeps the long prompt short: the simulator reads it at 2 ms a word
const BASE = { model: "llama3.2:3b", num_ctx: 512 };

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,1" } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
  await c.waitInstance("sim-2", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

const start = async (body) => {
  const r = await c.post("/api/benchmarks", { ...BASE, ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.benchmarks;
};

const finished = (id, timeout = 60_000) => waitFor(async () => {
  const r = await c.get(`/api/benchmarks/${id}`);
  return r.data.state !== "running" && r.data;
}, { timeout, what: `benchmark ${id} to finish` });

const stat = (b, cs, key) => b.summary.find((s) => s.case === cs)[key];

let warmA, warmB;

test("a warm benchmark repeats every prompt and records the conditions", async () => {
  const [b] = await start({ instances: ["sim-1"], repeat: 2, mode: "warm" });
  assert.equal(b.state, "running");
  assert.equal(b.spec.set, "v1");
  assert.deepEqual(b.spec.cases, ["short", "long_context", "long_generation"]);

  // it runs as a job, counted in runs
  const job = await c.job(b.id);
  assert.equal(job.kind, "benchmark");
  assert.equal(job.instance, "sim-1");

  const d = await finished(b.id);
  assert.equal(d.state, "done", d.error);
  assert.equal(d.runs.length, 6);
  assert.deepEqual(d.runs.map((r) => `${r.case}:${r.rep}`), [
    "short:1", "long_context:1", "long_generation:1", "short:2", "long_context:2", "long_generation:2",
  ]);
  // the warm-up load isn't a run: every timed run found the model loaded at the asked context
  assert.ok(d.runs.every((r) => r.state === "warm" && r.stats.load_ms < 50), JSON.stringify(d.runs.map((r) => r.stats.load_ms)));
  assert.ok(d.runs.every((r) => r.context === 512 && r.size_vram > 0 && r.split.state === "gpu"));

  const cond = d.conditions;
  assert.equal(cond.digest, (await c.get("/api/instances/sim-1/models")).data.models.find((m) => m.name === "llama3.2:3b").digest);
  assert.equal(cond.quantization, "Q4_K_M");
  assert.equal(cond.context, 512);
  // the simulator reports Ollama 0.12.6
  assert.equal(cond.ollama_version, "0.12.6");
  assert.ok(cond.agent_version && cond.dashboard_version, JSON.stringify(cond));
  assert.equal(cond.gpus.length, 1);
  assert.equal(cond.gpus[0].driver, "570.124.06");
  assert.ok(cond.cpu_count > 0 && cond.mem_total > 0);
  assert.ok(cond.env && typeof cond.env === "object", "the agent reports Ollama's settings");

  for (const cs of ["short", "long_context", "long_generation"]) {
    const s = d.summary.find((x) => x.case === cs);
    assert.equal(s.runs, 2);
    assert.equal(s.excluded, 0);
    assert.ok(s.tps.median > 0 && s.tps.min <= s.tps.median && s.tps.median <= s.tps.max, JSON.stringify(s.tps));
    assert.equal(typeof s.tps.cv, "number");
  }
  // the long prompt is read in full on every run: a repeated prompt would come from Ollama's cache
  const longPrompt = d.runs.filter((r) => r.case === "long_context").map((r) => r.stats.prompt_tokens);
  assert.ok(longPrompt.every((n) => n > 100), JSON.stringify(longPrompt));
  assert.ok(stat(d, "long_context", "prompt_tokens") > 10 * stat(d, "short", "prompt_tokens"));
  warmA = d;
});

test("a cold benchmark unloads the model before every run, so each includes the load", async () => {
  const [b] = await start({ instances: ["sim-2"], repeat: 2, mode: "cold", cases: ["short"] });
  const d = await finished(b.id);
  assert.equal(d.state, "done", d.error);
  assert.equal(d.runs.length, 2);
  // the simulator takes 300 ms to load a model
  assert.ok(d.runs.every((r) => r.state === "cold" && r.stats.load_ms >= 250 && r.stats.ttft_ms >= 250), JSON.stringify(d.runs.map((r) => r.stats)));
  assert.ok(stat(d, "short", "load_ms").median >= 250);
});

test("one model across the fleet: hosts run at once and compare under the same conditions", async () => {
  const bs = await start({ instances: ["sim-1", "sim-2"], repeat: 2, mode: "warm" });
  assert.equal(bs.length, 2);
  assert.equal(bs[0].batch, bs[1].batch);
  // two benchmarks on one host would measure each other
  const busy = await c.post("/api/benchmarks", { ...BASE, instances: ["sim-1"] });
  assert.equal(busy.status, 409);

  const [a, b] = await Promise.all(bs.map((x) => finished(x.id)));
  assert.equal(a.state, "done", a.error);
  assert.equal(b.state, "done", b.error);
  assert.equal(a.conditions.digest, b.conditions.digest);
  assert.deepEqual(a.spec, b.spec);
  // sim-2 streams each token 10 ms slower than sim-1
  assert.ok(stat(a, "long_generation", "tps").median > stat(b, "long_generation", "tps").median,
    JSON.stringify({ a: stat(a, "long_generation", "tps"), b: stat(b, "long_generation", "tps") }));
  warmB = b;

  // listed newest first, narrowed by host or model, without the runs
  const list = (await c.get("/api/benchmarks?model=llama3.2:3b")).data.benchmarks;
  assert.ok(list.some((x) => x.id === a.id) && list.some((x) => x.id === b.id));
  assert.ok(list.every((x) => x.model === "llama3.2:3b" && x.runs === undefined));
  assert.ok(list.every((x, i) => i === 0 || list[i - 1].started >= x.started));
  const sim2 = (await c.get("/api/benchmarks?instance=sim-2")).data.benchmarks;
  assert.ok(sim2.length >= 2 && sim2.every((x) => x.instance === "sim-2"));
});

test("bad requests and models that can't be benchmarked are refused", async () => {
  for (const body of [
    { instances: [] }, { instances: ["sim-1"], model: "" }, { instances: ["sim-1"], repeat: 0 }, { instances: ["sim-1"], repeat: 11 },
    { instances: ["sim-1"], num_ctx: 100 }, { instances: ["sim-1"], mode: "hot" }, { instances: ["sim-1"], cases: ["nope"] },
  ]) {
    const r = await c.post("/api/benchmarks", { ...BASE, ...body });
    assert.equal(r.status, 400, `${JSON.stringify(body)}: ${JSON.stringify(r.data)}`);
  }
  assert.equal((await c.post("/api/benchmarks", { ...BASE, instances: ["no-such-host"] })).status, 404);

  // a model the host doesn't have fails the benchmark, not the request: on a fleet run, other hosts carry on
  const [missing] = await start({ instances: ["sim-1"], model: "no-such-model:1b" });
  const d = await finished(missing.id);
  assert.equal(d.state, "error");
  assert.match(d.error, /isn't on/);
});

test("a viewer can read results but not start or delete a benchmark", async () => {
  const add = await c.post("/api/users", { username: "bench-viewer", role: "viewer" });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const v = new Client(stack.dashboard.url);
  assert.equal((await v.post("/api/auth/login", { username: "bench-viewer", password: add.data.password })).status, 200);
  assert.equal((await v.post("/api/auth/password", { password: "bench-viewer-password-1" })).status, 200);
  assert.equal((await v.get("/api/benchmarks")).status, 200);
  assert.equal((await v.get(`/api/benchmarks/${warmA.id}`)).status, 200);
  assert.equal((await v.post("/api/benchmarks", { ...BASE, instances: ["sim-1"] })).status, 403);
  assert.equal((await v.del(`/api/benchmarks/${warmA.id}`)).status, 403);
});

test("cancelling keeps the finished runs; deleting removes the result", async () => {
  const [b] = await start({ instances: ["sim-2"], repeat: 10, mode: "warm" });
  await waitFor(async () => (await c.get(`/api/benchmarks/${b.id}`)).data.runs.length >= 2, { what: "two runs" });
  assert.equal((await c.del(`/api/benchmarks/${b.id}`)).status, 200);
  const d = await finished(b.id, 15_000);
  assert.equal(d.state, "cancelled");
  assert.ok(d.runs.length >= 2 && d.runs.length < 30, `${d.runs.length} runs`);
  assert.equal((await c.job(b.id)).state, "cancelled");

  assert.equal((await c.del(`/api/benchmarks/${b.id}`)).status, 200);
  assert.equal((await c.get(`/api/benchmarks/${b.id}`)).status, 404);
});

test("results survive a restart; a benchmark cut off by one is marked interrupted", async () => {
  const [b] = await start({ instances: ["sim-1"], repeat: 10, mode: "warm" });
  await waitFor(async () => (await c.get(`/api/benchmarks/${b.id}`)).data.runs.length >= 1, { what: "a run" });
  await stack.dashboard.stop();
  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  const c2 = new Client(stack.dashboard.url);
  c2.cookie = c.cookie;
  c = c2;

  const cut = (await c.get(`/api/benchmarks/${b.id}`)).data;
  assert.equal(cut.state, "error");
  assert.match(cut.error, /interrupted/);
  assert.ok(cut.runs.length >= 1);
  assert.match((await c.job(b.id)).error, /interrupted/);

  for (const kept of [warmA, warmB]) {
    const d = (await c.get(`/api/benchmarks/${kept.id}`)).data;
    assert.deepEqual(d.runs, kept.runs);
    assert.deepEqual(d.conditions, kept.conditions);
    assert.deepEqual(d.summary, kept.summary);
  }
});
