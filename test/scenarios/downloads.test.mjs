// Interrupted downloads: a pull that fails or is cut off mid-stream ends as an error, a
// cancelled one as cancelled, and a later pull resumes where it stopped. Also checks that the
// model actions the dashboard offers work against the simulator.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

before(async () => {
  holder.stack = await startStack({ sim: { hosts: 1, pullSeconds: 2 } });
  ({ client: c, sim } = holder.stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

const pull = async (model) => {
  const r = await c.post("/api/instances/sim-1/models/pull", { model });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const pullsOf = async (model) => (await sim.state("sim-1")).pulls.filter((p) => p.model === model);
const tags = async () => (await c.get("/api/instances/sim-1/models")).data.models.map((m) => m.name);

test("a pull streams progress and the model shows up", async () => {
  const job = await pull("tinyllama:1.1b");
  assert.equal(job.state, "running");
  const progress = await c.waitJob(job.id, (j) => j.completed > 0 && j.total > 0, "progress");
  assert.match(progress.status, /^pulling /);
  const done = await c.waitJob(job.id, (j) => j.state !== "running", "finished");
  assert.equal(done.state, "done");
  assert.equal(done.status, "success");
  assert.equal(done.completed, done.total);
  assert.ok((await tags()).includes("tinyllama:1.1b"));
});

test("pulling the same model twice reuses the running job", async () => {
  await sim.scenario("sim-1", { pull: "stall" });
  const a = await pull("smollm:360m");
  const b = await pull("smollm:360m");
  assert.equal(b.id, a.id);
  assert.equal((await c.del(`/api/jobs/${a.id}`)).status, 200);
  await c.waitJob(a.id, (j) => j.state === "cancelled", "cancelled");
  await sim.scenario("sim-1", { pull: "normal" });
});

test("a pull that fails mid-stream ends as error", async () => {
  await sim.scenario("sim-1", { pull: "fail" });
  const job = await pull("phi3:mini");
  const j = await c.waitJob(job.id, (x) => x.state !== "running", "finished");
  assert.equal(j.state, "error");
  assert.match(j.error, /simulated failure/);
  assert.ok(j.finished);
  assert.equal((await pullsOf("phi3:mini")).at(-1).outcome, "failed");
  assert.equal((await tags()).includes("phi3:mini"), false);
});

test("a pull whose connection drops ends as error", async () => {
  await sim.scenario("sim-1", { pull: "drop" });
  const job = await pull("gemma3:1b");
  const j = await c.waitJob(job.id, (x) => x.state !== "running", "finished");
  assert.equal(j.state, "error");
  assert.ok(j.error, "the error is reported");
  assert.equal((await pullsOf("gemma3:1b")).at(-1).outcome, "dropped");
});

test("a cancelled pull ends as cancelled", async () => {
  await sim.scenario("sim-1", { pull: "stall" });
  const job = await pull("mistral:7b");
  await c.waitJob(job.id, (j) => j.completed > 0, "some progress");
  assert.equal((await c.del(`/api/jobs/${job.id}`)).status, 200);
  const j = await c.waitJob(job.id, (x) => x.state !== "running", "finished");
  assert.equal(j.state, "cancelled");
  assert.equal(j.status, "cancelled");
  // the simulator saw the connection close, as Ollama would
  await waitFor(async () => (await pullsOf("mistral:7b")).at(-1).outcome === "aborted", { what: "the sim to see the cancel" });
});

test("pulling again resumes where the interrupted pull stopped", async () => {
  await sim.scenario("sim-1", { pull: "normal" });
  const job = await pull("mistral:7b");
  const j = await c.waitJob(job.id, (x) => x.state !== "running", "finished");
  assert.equal(j.state, "done");
  const pulls = await pullsOf("mistral:7b");
  assert.equal(pulls.length, 2);
  assert.ok(pulls[1].resumed_from > 0, "the second pull started from the partial download");
  assert.equal(pulls[1].resumed_from, pulls[0].completed);
});

test("finished jobs can be cleared", async () => {
  const { jobs } = (await c.get("/api/jobs")).data;
  const finished = jobs.find((j) => j.state !== "running");
  assert.equal((await c.del(`/api/jobs/${finished.id}`)).status, 200);
  assert.equal((await c.job(finished.id)), undefined);
});

test("model actions: show, load, unload, copy, create, delete", async () => {
  const m = (action, body) => c.post(`/api/instances/sim-1/models/${action}`, body);

  const show = await m("show", { model: "qwen2.5-coder:7b" });
  assert.equal(show.status, 200);
  assert.equal(show.data.native_context_length, 32768);
  assert.equal(show.data.architecture, "qwen2");
  assert.equal(show.data.parameters.temperature, 0.7);

  assert.equal((await m("load", { model: "qwen2.5-coder:7b", keep_alive: "10m" })).status, 200);
  await c.waitInstance("sim-1", (x) => x.ps.some((p) => p.name === "qwen2.5-coder:7b"), "model loaded");
  assert.equal((await m("unload", { model: "qwen2.5-coder:7b" })).status, 200);
  await c.waitInstance("sim-1", (x) => !x.ps.some((p) => p.name === "qwen2.5-coder:7b"), "model unloaded");

  assert.equal((await m("copy", { source: "llama3.2:3b", destination: "my-llama:latest" })).status, 200);
  const create = await m("create", { model: "my-llama:ctx16k", from: "my-llama:latest", parameters: { num_ctx: 16384 }, system: "Be brief." });
  assert.equal(create.status, 200);
  const created = await c.waitJob(create.data.id, (j) => j.state !== "running", "created");
  assert.equal(created.state, "done");
  const shown = await m("show", { model: "my-llama:ctx16k" });
  assert.equal(shown.data.parameters.num_ctx, 16384);
  assert.equal(shown.data.system, "Be brief.");

  for (const model of ["my-llama:ctx16k", "my-llama:latest"]) assert.equal((await m("delete", { model })).status, 200);
  const names = await tags();
  assert.equal(names.includes("my-llama:latest"), false);
  const missing = await m("delete", { model: "my-llama:latest" });
  assert.equal(missing.status, 404);
});
