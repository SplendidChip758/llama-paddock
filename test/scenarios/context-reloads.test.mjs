// Context and reload warnings: a loaded model's context is shown against the most it supports and
// what the host sets (OLLAMA_CONTEXT_LENGTH or the Modelfile's num_ctx), a smaller one is flagged as
// probably set by a client, and models that load again and again are flagged with the likely cause:
// from the polls, and from Ollama's log for loads too short for a poll to see. Both are alert kinds.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

const RULES = [
  { id: "ctx", name: "Context cut short", kind: "context_short", for_s: 0, clear_s: 1 },
  { id: "churn", name: "Reloading", kind: "reload_churn", threshold: 4, for_s: 0, clear_s: 1 },
];

before(async () => {
  holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,1", pullSeconds: 1 } });
  ({ client: c, sim } = holder.stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok && x.ps.length, "online with a loaded model");
  await c.waitInstance("sim-2", (x) => x.ollama_ok && x.agent_ok, "online");
  assert.equal((await c.put("/api/alerts/rules", { rules: RULES })).status, 200);
});
after(() => holder.stack?.stop());

const loaded = (inst, name) => inst.ps.find((m) => m.name === name);
const alertOf = async (rule, instance, subject) =>
  (await c.get("/api/alerts")).data.active.find((a) => a.rule === rule && a.instance === instance && a.subject === subject);
const transitions = async () => (await c.get("/api/alerts/transitions?limit=1000")).data.transitions;
/** Send a request the way a client of Ollama would. */
async function generate(id, body) {
  const r = await fetch(`${sim.host(id).ollama_url}/api/generate`, { method: "POST", body: JSON.stringify({ stream: false, ...body }) });
  assert.equal(r.status, 200, await r.text());
}
/** Load a model with a context, and wait until a poll has seen it. */
async function loadWith(id, model, numCtx) {
  await generate(id, { model, ...(numCtx ? { options: { num_ctx: numCtx } } : {}) });
  return c.waitInstance(id, (x) => loaded(x, model)?.context_length === (numCtx ?? loaded(x, model)?.context_length) && loaded(x, model)?.context,
    `${model} loaded with num_ctx ${numCtx ?? "unset"}`);
}

test("a model's context is shown against the most it supports, and Ollama's default is pointed out", async () => {
  const inst = await c.waitInstance("sim-1", (x) => loaded(x, "llama3.2:3b")?.context?.state === "default", "the context check");
  const ctx = loaded(inst, "llama3.2:3b").context;
  assert.equal(ctx.running, 4096);
  assert.equal(ctx.max, 131072);
  assert.equal(ctx.configured, null);
  assert.match(ctx.hint, /OLLAMA_CONTEXT_LENGTH/);
  assert.deepEqual(inst.reload_churn, []);
});

test("a client asking for less than OLLAMA_CONTEXT_LENGTH is flagged and fires the alert, which resolves on unload", async () => {
  const env = await c.put("/api/instances/sim-1/env", {
    vars: { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_KEEP_ALIVE: "5m", OLLAMA_CONTEXT_LENGTH: "16384" }, restart: true,
  });
  assert.equal(env.status, 200, JSON.stringify(env.data));
  // the host's value applies when the client leaves num_ctx out
  await generate("sim-1", { model: "llama3.2:3b" });
  let inst = await c.waitInstance("sim-1", (x) => loaded(x, "llama3.2:3b")?.context?.configured === 16384, "the new environment read");
  assert.equal(loaded(inst, "llama3.2:3b").context.state, "ok");
  assert.equal(loaded(inst, "llama3.2:3b").context.configured_by, "env");

  inst = await loadWith("sim-1", "llama3.2:3b", 2048);
  const ctx = loaded(inst, "llama3.2:3b").context;
  assert.equal(ctx.state, "short", JSON.stringify(ctx));
  assert.match(ctx.hint, /less than the 16,384 the host sets \(OLLAMA_CONTEXT_LENGTH=16384\)\. A client probably asked for num_ctx 2,048/);
  await waitFor(async () => (await alertOf("ctx", "sim-1", "llama3.2:3b"))?.state === "firing", { what: "the context alert firing" });

  const since = Date.now() / 1000;
  await generate("sim-1", { model: "llama3.2:3b", keep_alive: 0 });
  await waitFor(async () => (await transitions()).find((x) => x.rule === "ctx" && x.subject === "llama3.2:3b" && x.state === "resolved" && x.t > since),
    { what: "the context alert resolved after the unload" });
});

test("num_ctx in the Modelfile counts as what the host sets", async () => {
  const r = await c.post("/api/instances/sim-2/models/create", { model: "llama-32k", from: "llama3.2:3b", parameters: { num_ctx: 32768 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.waitJob(r.data.id, (j) => j.state === "done", "the create");
  let ctx = loaded(await loadWith("sim-2", "llama-32k:latest"), "llama-32k:latest").context;
  assert.equal(ctx.state, "ok", JSON.stringify(ctx));
  assert.equal(ctx.configured_by, "modelfile");
  ctx = loaded(await loadWith("sim-2", "llama-32k:latest", 8192), "llama-32k:latest").context;
  assert.equal(ctx.state, "short");
  assert.match(ctx.hint, /num_ctx 32,768 in its Modelfile/);
  await generate("sim-2", { model: "llama-32k:latest", keep_alive: 0 });
});

test("clients alternating context sizes reload the model, and the warning says so", async () => {
  // 11 loads: more than the 10 an hour the host page warns about
  for (let i = 0; i < 11; i++) await loadWith("sim-2", "qwen2.5-coder:7b", i % 2 ? 8192 : 4096);
  const inst = await c.waitInstance("sim-2", (x) => x.reload_churn.some((y) => y.model === "qwen2.5-coder:7b"), "the reload warning");
  const churn = inst.reload_churn.find((y) => y.model === "qwen2.5-coder:7b");
  assert.ok(churn.loads >= 11, JSON.stringify(churn));
  assert.match(churn.causes[0], /different context sizes \(4,096, 8,192\)/);
  assert.match(churn.fixes[0], /same num_ctx/);
  const a = await waitFor(async () => (await alertOf("churn", "sim-2", "qwen2.5-coder:7b"))?.state === "firing" && alertOf("churn", "sim-2", "qwen2.5-coder:7b"),
    { what: "the reload alert firing" });
  assert.match(a.detail, /Likely cause: Clients ask for different context sizes/);
});

test("loads too short for any poll to see are counted from Ollama's log", async () => {
  // keep_alive 0: each request loads, answers and unloads before a poll can see it
  for (let i = 0; i < 14; i++) await generate("sim-1", { model: "nomic-embed-text", prompt: "hi", keep_alive: 0 });
  // the log is read every 20 polls
  const inst = await c.waitInstance("sim-1", (x) => x.reload_churn.some((y) => y.model === null), "the unseen loads counted", 60_000);
  const churn = inst.reload_churn.find((y) => y.model === null);
  assert.ok(churn.loads > 10, JSON.stringify(churn));
  assert.match(churn.summary, /no poll saw/);
  assert.match(churn.causes[0], /keep_alive 0/);
  await waitFor(async () => (await alertOf("churn", "sim-1", ""))?.state === "firing", { what: "the reload alert for unseen loads" });
});

test("without the log (agents before 0.8.0), counts are a minimum", async () => {
  await sim.scenario("sim-2", { agent_version: "0.7.0" });
  const inst = await c.waitInstance("sim-2", (x) => x.reload_churn.some((y) => /loaded at least \d+ times/.test(y.summary)), "the counts marked as a minimum",
    60_000);
  assert.ok(inst.reload_churn.every((y) => y.model !== null), "no unseen-load entry without the log");
});
