// Rejected credentials (#5): a missing or wrong Ollama API key and a wrong agent token show as
// readable errors on the host, and the API answers 502, never 401, so the browser doesn't take it
// for its own session expiring.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { scenarioTest, startStack } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim;

before(async () => {
  // both hosts sit behind an API key; the dashboard only knows sim-1's
  holder.stack = await startStack({
    sim: { hosts: 2, ollamaKey: "sim-key-1,sim-key-2" },
    data: { instances: { "sim-2": { ollama_api_key: null } } },
  });
  ({ client: c, sim } = holder.stack);
});
after(() => holder.stack?.stop());

const signedIn = async () => {
  const me = await c.get("/api/auth/me");
  assert.equal(me.status, 200, "the dashboard session must stay valid");
  assert.equal(me.data.username, "admin");
};

test("the right API key is accepted", async () => {
  const i = await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
  assert.equal(i.has_ollama_key, true);
  assert.equal(JSON.stringify(i).includes("sim-key-1"), false, "the key never reaches the browser");
});

test("missing API key: 'Ollama needs an API key', 502 not 401", async () => {
  const i = await c.waitInstance("sim-2", (x) => !x.ollama_ok && x.ollama_error, "rejected");
  assert.match(i.ollama_error, /Ollama needs an API key \(401\)/);
  assert.ok(i.agent_ok, "the agent is unaffected");
  const r = await c.get("/api/instances/sim-2/models");
  assert.equal(r.status, 502);
  assert.match(r.data.detail, /needs an API key/);
  await signedIn();
});

test("wrong API key: 'Ollama rejected the API key', 502 not 401", async () => {
  await sim.scenario("sim-1", { ollama_key: "rotated-key" });
  const i = await c.waitInstance("sim-1", (x) => !x.ollama_ok, "rejected");
  assert.match(i.ollama_error, /Ollama rejected the API key \(401\)/);
  const r = await c.post("/api/instances/sim-1/models/show", { model: "llama3.2:3b" });
  assert.equal(r.status, 502);
  assert.match(r.data.detail, /rejected the API key/);
  await signedIn();
});

test("a pull with a rejected key ends as an error that names the key", async () => {
  const start = await c.post("/api/instances/sim-1/models/pull", { model: "phi3:mini" });
  assert.equal(start.status, 200);
  const j = await c.waitJob(start.data.id, (x) => x.state !== "running", "finished");
  assert.equal(j.state, "error");
  assert.match(j.error, /rejected the API key/);
});

test("the connection test reports a wrong key and a wrong token separately", async () => {
  const h = sim.host("sim-1");
  const r = await c.post("/api/test-connection", {
    ollama_url: h.ollama_url, ollama_api_key: "wrong", agent_url: h.agent_url, agent_token: "wrong",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ollama.ok, false);
  assert.match(r.data.ollama.detail, /rejected the API key/);
  assert.equal(r.data.agent.ok, false);
  assert.match(r.data.agent.detail, /invalid agent token/);
});

test("the key works again once it matches", async () => {
  await sim.scenario("sim-1", { ollama_key: "sim-key-1" });
  await c.waitInstance("sim-1", (x) => x.ollama_ok, "accepted again");
});

test("wrong agent token: agent error, 502 not 401, session still valid", async () => {
  await sim.scenario("sim-1", { agent_token: "rotated-token" });
  const i = await c.waitInstance("sim-1", (x) => !x.agent_ok, "agent rejected");
  assert.match(i.agent_error, /agent: invalid agent token/);
  assert.ok(i.ollama_ok, "Ollama is unaffected");
  for (const p of ["/api/instances/sim-1/logs", "/api/instances/sim-1/env"]) {
    const r = await c.get(p);
    assert.equal(r.status, 502, p);
    assert.match(r.data.detail, /invalid agent token/);
  }
  const restart = await c.post("/api/instances/sim-1/restart");
  assert.equal(restart.status, 502);
  await signedIn();
});

test("an agent that rejects every token is reported the same way", async () => {
  await sim.scenario("sim-1", { agent_token: "sim-token", agent: "bad-token" });
  await c.waitInstance("sim-1", (x) => !x.agent_ok && /invalid agent token/.test(x.agent_error), "agent rejected");
  await sim.scenario("sim-1", { agent: "up" });
  await c.waitInstance("sim-1", (x) => x.agent_ok, "agent accepted again");
  await signedIn();
});
