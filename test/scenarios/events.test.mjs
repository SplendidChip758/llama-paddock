// Availability and model events: Ollama and the agent going down and up are recorded separately,
// loads and unloads are recorded with their digest, and time in which the dashboard wasn't
// running is a gap in observation (unknown), not uptime or downtime.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { Client, scenarioTest, startDashboard, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 1 } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

const events = async (range = "1h") => {
  const r = await c.get(`/api/instances/sim-1/events?range=${range}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
/** Wait until the event history has an event matching `pred`. */
const waitEvent = (pred, what) => waitFor(async () => (await events()).events.find(pred), { what });

/** Load or unload a model the way a client of Ollama would, past the dashboard. */
async function generate(body) {
  const h = sim.host("sim-1");
  const r = await fetch(`${h.ollama_url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(h.ollama_key ? { Authorization: `Bearer ${h.ollama_key}` } : {}) },
    body: JSON.stringify({ stream: false, ...body }),
  });
  assert.equal(r.status, 200, await r.text());
}

test("the first poll records the state as found, marked first", async () => {
  const h = await waitFor(async () => {
    const d = await events();
    return d.events.some((e) => e.kind === "load") && d.coverage > 0 && d;
  }, { what: "the first events" });
  const kinds = h.events.filter((e) => e.first).map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["agent", "load", "ollama"]);
  const load = h.events.find((e) => e.kind === "load");
  assert.equal(load.model, "llama3.2:3b");
  assert.match(load.digest, /^[0-9a-f]{64}$/);
  assert.equal(h.observed.length, 1);
  assert.ok(h.coverage > 0 && h.coverage < 1);
  assert.equal(h.ollama.down, 0);
});

test("unknown ranges are refused", async () => {
  const r = await c.get("/api/instances/sim-1/events?range=2h");
  assert.equal(r.status, 400);
});

test("a model loaded and unloaded by a client is recorded, with its context", async () => {
  await generate({ model: "qwen2.5-coder:7b", keep_alive: "5m", options: { num_ctx: 8192 } });
  const load = await waitEvent((e) => e.kind === "load" && e.model === "qwen2.5-coder:7b", "a load event");
  assert.equal(load.first, false);
  assert.equal(load.context_length, 8192);
  assert.ok(load.size_vram > 0);

  // the same model with another context is a reload: an unload and a load
  await generate({ model: "qwen2.5-coder:7b", keep_alive: "5m", options: { num_ctx: 16384 } });
  await waitEvent((e) => e.kind === "load" && e.model === "qwen2.5-coder:7b" && e.context_length === 16384, "a reload");
  assert.ok((await events()).events.some((e) => e.kind === "unload" && e.model === "qwen2.5-coder:7b" && e.context_length === 8192));

  await generate({ model: "qwen2.5-coder:7b", keep_alive: 0 });
  await waitEvent((e) => e.kind === "unload" && e.model === "qwen2.5-coder:7b" && e.context_length === 16384, "an unload event");
});

test("agent down with Ollama up: only the agent is recorded down", async () => {
  await sim.scenario("sim-1", { agent: "down" });
  const down = await waitEvent((e) => e.kind === "agent" && !e.up, "agent down");
  assert.match(down.error, /agent unreachable/);
  assert.ok(!(await events()).events.some((e) => e.kind === "ollama" && !e.up), "Ollama stays up");
  await sim.scenario("sim-1", { agent: "up" });
  await waitEvent((e) => e.kind === "agent" && e.up && !e.first, "agent back up");
});

test("Ollama down: recorded with its error, loaded models become unknown until it's back", async () => {
  await sim.scenario("sim-1", { ollama: "down" });
  const down = await waitEvent((e) => e.kind === "ollama" && !e.up, "Ollama down");
  assert.match(down.error, /ollama unreachable/);
  // no unload events: while Ollama can't be reached, nobody knows what it has loaded
  assert.ok(!(await events()).events.some((e) => e.kind === "unload" && e.model === "llama3.2:3b"));

  await sim.scenario("sim-1", { ollama: "up" });
  const up = await waitEvent((e) => e.kind === "ollama" && e.up && e.t > down.t, "Ollama back up");
  assert.equal(up.first, false);
  // the models found after the outage are first observations, not loads seen as they happened
  const after = (await events()).events.filter((e) => e.kind === "load" && e.t >= up.t);
  assert.ok(after.length && after.every((e) => e.first), JSON.stringify(after));

  const h = await events();
  assert.ok(h.ollama.down > 0, "downtime is counted");
  assert.equal(h.agent.down > 0, true);
});

test("a dashboard restart is a gap in observation, then the state is recorded again", async () => {
  const before = await events();
  await stack.dashboard.stop();
  await new Promise((r) => setTimeout(r, 2500));
  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  const c2 = new Client(stack.dashboard.url);
  c2.cookie = c.cookie;
  c = c2;

  const h = await waitFor(async () => {
    const d = await events();
    return d.observed.length === 2 && d.events.length > before.events.length && d;
  }, { what: "a second observed span" });
  const [a, b] = h.observed;
  assert.ok(b.start - a.end >= 2, `a gap between spans: ${JSON.stringify(h.observed)}`);
  const restarted = h.events.filter((e) => e.t >= b.start);
  assert.ok(restarted.length >= 2 && restarted.every((e) => e.first), JSON.stringify(restarted));
  // history from before the restart is kept
  assert.ok(h.events.some((e) => e.t < a.end && e.kind === "load" && e.model === "qwen2.5-coder:7b"));
  // the gap is neither up nor down
  const total = h.ollama.up + h.ollama.down + h.ollama.unknown;
  assert.ok(total < h.to - a.start - 2, `observed time ${total} excludes the gap`);
});
