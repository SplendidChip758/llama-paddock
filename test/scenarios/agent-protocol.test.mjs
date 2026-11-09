// Agent protocol: agents report the protocol they speak, the dashboard declares the range it supports,
// and an agent outside that range is flagged with what to update and not called until it's back in
// range. A fleet can mix agent versions, and either side can be upgraded first.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { metric, scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

const RULES = [{ id: "agent", name: "Agent unreachable", kind: "agent_unreachable", for_s: 1, clear_s: 1 }];

before(async () => {
  holder.stack = await startStack({ sim: { hosts: 3 } });
  ({ client: c, sim } = holder.stack);
  for (const id of ["sim-1", "sim-2", "sim-3"]) await c.waitInstance(id, (x) => x.ollama_ok && x.agent_ok, "online");
  assert.equal((await c.put("/api/alerts/rules", { rules: RULES })).status, 200);
});
after(() => holder.stack?.stop());

const now = () => Date.now() / 1000;
const usable = (x) => x.agent_ok && !x.agent_incompatible && x.stats;
const transitions = async () => (await c.get("/api/alerts/transitions?limit=1000")).data.transitions.filter((x) => x.rule === "agent");
const agentEvents = async (id, since) =>
  (await c.get(`/api/instances/${id}/events?range=1h`)).data.events.filter((e) => e.kind === "agent" && e.t > since);

test("the dashboard reports the protocols it supports, and the agents the one they speak", async () => {
  const h = await c.get("/api/healthz");
  assert.equal(h.status, 200);
  assert.deepEqual(h.data.agent_protocol, { min: 1, max: 1 });
  const i = await c.instance("sim-1");
  assert.equal(i.agent_protocol, 1);
  assert.equal(i.agent_incompatible, null);
  const health = await fetch(`${sim.host("sim-1").agent_url.replace("https:", "http:")}/health`).then((r) => r.json());
  assert.equal(health.protocol, 1);
});

test("a mixed fleet: agents from before the protocol, and older ones, still work", async () => {
  // 0.9.0 reports no protocol; 0.7.1 has neither the protocol nor /gpu-check and /runner-starts
  await sim.scenario("sim-2", { agent_protocol: null, agent_version: "0.9.0" });
  await sim.scenario("sim-3", { agent_protocol: null, agent_version: "0.7.1" });
  const two = await c.waitInstance("sim-2", (x) => x.agent_version === "0.9.0" && usable(x), "0.9.0 agent in use");
  const three = await c.waitInstance("sim-3", (x) => x.agent_version === "0.7.1" && usable(x), "0.7.1 agent in use");
  assert.equal(two.agent_protocol, 1);
  assert.equal(three.agent_protocol, 1);
  assert.equal((await c.get("/api/instances/sim-3/env")).status, 200);
});

test("dashboard first: updating an agent to the protocol doesn't interrupt it", async () => {
  const since = now();
  await sim.scenario("sim-2", { agent_protocol: 1, agent_version: "0.10.0" });
  await c.waitInstance("sim-2", (x) => x.agent_version === "0.10.0" && usable(x), "updated agent in use");
  assert.deepEqual(await agentEvents("sim-2", since), [], "no agent outage recorded");
});

test("agents first: an agent on a newer protocol is flagged and left alone until the dashboard catches up", async () => {
  const since = now();
  await sim.scenario("sim-1", { agent_protocol: 2, agent_version: "2.0.0" });
  const i = await c.waitInstance("sim-1", (x) => x.agent_incompatible, "flagged");
  assert.equal(i.agent_incompatible, "update-dashboard");
  assert.equal(i.agent_protocol, 2);
  assert.equal(i.agent_version, "2.0.0");
  assert.equal(i.agent_ok, false);
  assert.equal(i.stats, null, "nothing it reports is used");
  assert.match(i.agent_error, /incompatible: it speaks protocol 2, but this dashboard supports 1; update the dashboard/);
  assert.ok(i.ollama_ok, "Ollama itself is unaffected");

  // no calls beyond the poll: they could mean something else on protocol 2
  const envCalls = async () => (await sim.state("sim-1")).requests["agent GET /env"] ?? 0;
  const before = await envCalls();
  const env = await c.get("/api/instances/sim-1/env");
  assert.equal(env.status, 409);
  assert.match(env.data.detail, /update the dashboard/);
  assert.equal(await envCalls(), before, "the agent wasn't asked");

  // the connection test says so too, and it's an outage on the timeline, with its reason
  const h = sim.host("sim-1");
  const t = await c.post("/api/test-connection", { ollama_url: h.ollama_url, agent_url: h.agent_url, agent_token: h.agent_token });
  assert.equal(t.status, 200);
  assert.equal(t.data.agent.ok, false);
  assert.match(t.data.agent.detail, /protocol 2.*update the dashboard/);
  const [down] = await waitFor(async () => {
    const e = await agentEvents("sim-1", since);
    return e.length && e;
  }, { what: "the agent outage event" });
  assert.equal(down.up, false);
  assert.match(down.error, /^incompatible: /);

  const m = (await c.get("/metrics")).data;
  assert.equal(metric(m, "paddock_agent_up", { instance: "sim-1" }), 0);

  const fired = await waitFor(async () => (await transitions()).find((x) => x.instance === "sim-1" && x.state === "firing" && x.t > since), { what: "the alert" });
  assert.match(fired.detail, /update the dashboard/);
});

test("rolling the agent back to a supported protocol resumes it and resolves the alert", async () => {
  const since = now();
  await sim.scenario("sim-1", { agent_protocol: 1, agent_version: "0.10.0" });
  const i = await c.waitInstance("sim-1", usable, "in use again");
  assert.equal(i.agent_incompatible, null);
  assert.equal(i.agent_error, null);
  assert.equal((await c.get("/api/instances/sim-1/env")).status, 200);
  await waitFor(async () => (await transitions()).find((x) => x.instance === "sim-1" && x.state === "resolved" && x.t > since), { what: "resolved" });
});

test("an agent on a protocol this dashboard no longer supports is told to update", async () => {
  await sim.scenario("sim-3", { agent_protocol: 0 });
  const i = await c.waitInstance("sim-3", (x) => x.agent_incompatible, "flagged");
  assert.equal(i.agent_incompatible, "update-agent");
  assert.match(i.agent_error, /incompatible: it speaks protocol 0, but this dashboard supports 1; update the agent/);
  await sim.scenario("sim-3", { agent_protocol: 1 });
  await c.waitInstance("sim-3", usable, "updated agent in use");
});
