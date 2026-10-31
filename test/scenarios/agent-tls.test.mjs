// Encrypted agent connections (#68): the dashboard pins an https:// agent's key on first contact
// (or takes it from config.yaml), stops calling an agent whose key changed until someone accepts
// the new key, and offers http:// agents that report a key the switch to HTTPS.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, data;
// valid in form, but no agent's key
const WRONG = `SHA256:${Buffer.alloc(32).toString("base64").replace(/=+$/, "")}`;

before(async () => {
  holder.stack = await startStack({
    sim: { hosts: 4 },
    data: (s) => ({
      instances: {
        "sim-1": { agent_url: s.host("sim-1").agent_https_url },
        "sim-2": { agent_url: s.host("sim-2").agent_https_url, agent_fingerprint: WRONG },
      },
    }),
  });
  ({ client: c, sim, data } = holder.stack);
});
after(() => holder.stack?.stop());

const fingerprint = async (id) => (await sim.state(id)).agent_fingerprint;
const agentCalls = async (id) => {
  const r = (await sim.state(id)).requests;
  return Object.entries(r).filter(([k]) => k.startsWith("agent ")).reduce((s, [, n]) => s + n, 0);
};
const pins = () => JSON.parse(fs.readFileSync(path.join(data.data, "agent-pins.json"), "utf8"));

test("an https:// agent's key is pinned on first contact and kept in the data directory", async () => {
  const i = await c.waitInstance("sim-1", (x) => x.agent_ok, "agent online over HTTPS");
  assert.equal(i.agent_url, sim.host("sim-1").agent_https_url);
  assert.equal(i.agent_fingerprint, await fingerprint("sim-1"));
  assert.equal(i.agent_https_fingerprint, null, "nothing to switch: it's already HTTPS");
  assert.deepEqual(pins()["sim-1"], { agent_url: i.agent_url, fingerprint: i.agent_fingerprint });
  assert.equal(fs.statSync(path.join(data.data, "agent-pins.json")).mode & 0o777, 0o600);
});

test("a replaced key stops the agent calls until the new key is accepted", async () => {
  const fresh = (await sim.scenario("sim-1", { agent_key: "new" })).agent_fingerprint;
  const i = await c.waitInstance("sim-1", (x) => x.agent_key_changed, "key change noticed");
  assert.equal(i.agent_key_changed, fresh);
  assert.equal(i.agent_ok, false);
  assert.match(i.agent_error, /presented the key/);
  assert.ok(i.ollama_ok, "Ollama is still polled");

  // no request reaches the agent any more: the TLS connection is closed before the token is sent
  const calls = await agentCalls("sim-1");
  await new Promise((r) => setTimeout(r, 3000));
  const env = await c.get("/api/instances/sim-1/env");
  assert.equal(env.status, 502);
  assert.match(env.data.detail, /presented the key/);
  assert.equal(await agentCalls("sim-1"), calls, "requests reached an agent with an unpinned key");

  assert.equal((await c.post("/api/instances/sim-1/agent-key", { fingerprint: "not a fingerprint" })).status, 400);
  const ok = await c.post("/api/instances/sim-1/agent-key", { fingerprint: fresh });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const back = await c.waitInstance("sim-1", (x) => x.agent_ok, "agent online with the new key");
  assert.equal(back.agent_fingerprint, fresh);
  assert.equal(back.agent_key_changed, null);
  assert.equal(pins()["sim-1"].fingerprint, fresh);
});

test("a key pinned in config.yaml is enforced and can only be changed there", async () => {
  const i = await c.waitInstance("sim-2", (x) => x.agent_key_changed, "pinned key doesn't match");
  assert.equal(i.agent_fingerprint, WRONG);
  assert.equal(i.agent_fingerprint_in_config, true);
  assert.equal(i.agent_key_changed, await fingerprint("sim-2"));
  const r = await c.post("/api/instances/sim-2/agent-key", { fingerprint: i.agent_key_changed });
  assert.equal(r.status, 409);
  assert.match(r.data.detail, /config\.yaml/);
  assert.equal(pins()["sim-2"], undefined, "a pin from config.yaml isn't copied to the data directory");
});

test("an http:// agent reports its key; a config.yaml host is switched in config.yaml", async () => {
  const i = await c.waitInstance("sim-3", (x) => x.agent_ok && x.agent_https_fingerprint, "key reported over HTTP");
  assert.equal(i.agent_https_fingerprint, await fingerprint("sim-3"));
  assert.equal(i.agent_fingerprint, null);
  const r = await c.post("/api/instances/sim-3/agent-https");
  assert.equal(r.status, 409);
  assert.match(r.data.detail, /config\.yaml/);
});

test("a host added in the UI switches to HTTPS and keeps its history", async () => {
  const h = sim.host("sim-4");
  const add = await c.post("/api/instances", { name: "ui-4", ollama_url: h.ollama_url, agent_url: h.agent_url, agent_token: h.agent_token });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const id = add.data.id;
  await c.waitInstance(id, (x) => x.agent_ok && x.agent_https_fingerprint, "key reported over HTTP");
  const points = await waitFor(async () => {
    const r = await c.get(`/api/instances/${id}/history`);
    return r.data.points.length >= 2 && r.data.points.length;
  }, { what: "some history" });

  const sw = await c.post(`/api/instances/${id}/agent-https`);
  assert.equal(sw.status, 200, JSON.stringify(sw.data));
  assert.equal(sw.data.agent_url, h.agent_https_url);
  assert.equal(sw.data.agent_fingerprint, await fingerprint("sim-4"));
  const i = await c.waitInstance(id, (x) => x.agent_ok && x.agent_url === h.agent_https_url, "agent online over HTTPS");
  assert.equal(i.agent_https_fingerprint, null);
  assert.ok((await c.get(`/api/instances/${id}/history`)).data.points.length >= points, "history was kept");

  const saved = JSON.parse(fs.readFileSync(path.join(data.data, "hosts.json"), "utf8")).instances.find((x) => x.id === id);
  assert.equal(saved.agent_url, h.agent_https_url);
  assert.equal(saved.agent_fingerprint, sw.data.agent_fingerprint);
  assert.equal("agent_fingerprint_in_config" in saved, false);
  assert.equal((await c.del(`/api/instances/${id}`)).status, 200);
});

test("an HTTPS-only agent answers http:// with 426 and its key, and the switch still works", async () => {
  const h = sim.host("sim-4");
  await sim.scenario("sim-4", { agent_http: false });
  const add = await c.post("/api/instances", { name: "ui-4-https-only", ollama_url: h.ollama_url, agent_url: h.agent_url, agent_token: h.agent_token });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const id = add.data.id;
  const i = await c.waitInstance(id, (x) => !x.agent_ok && x.agent_https_fingerprint, "refused over HTTP");
  assert.match(i.agent_error, /only accepts HTTPS/);
  assert.equal((await c.post(`/api/instances/${id}/agent-https`)).status, 200);
  await c.waitInstance(id, (x) => x.agent_ok, "agent online over HTTPS");
  assert.equal((await c.del(`/api/instances/${id}`)).status, 200);
  await sim.scenario("sim-4", { agent_http: true });
});

test("the connection test shows the agent's key and fails on a wrong fingerprint", async () => {
  const h = sim.host("sim-4");
  const fp = await fingerprint("sim-4");
  const form = { ollama_url: h.ollama_url, agent_token: h.agent_token };

  const tofu = await c.post("/api/test-connection", { ...form, agent_url: h.agent_https_url });
  assert.equal(tofu.data.agent.ok, true, JSON.stringify(tofu.data));
  assert.equal(tofu.data.agent.fingerprint, fp);

  const wrong = await c.post("/api/test-connection", { ...form, agent_url: h.agent_https_url, agent_fingerprint: WRONG });
  assert.equal(wrong.data.agent.ok, false);
  assert.match(wrong.data.agent.detail, /presented the key/);
  assert.equal(wrong.data.agent.fingerprint, fp);

  const plain = await c.post("/api/test-connection", { ...form, agent_url: h.agent_url });
  assert.equal(plain.data.agent.ok, true);
  assert.equal(plain.data.agent.fingerprint, fp, "an http:// agent reports the key it would serve HTTPS with");

  const bad = await c.post("/api/test-connection", { ...form, agent_url: h.agent_https_url, agent_fingerprint: "SHA256:nope" });
  assert.equal(bad.status, 400);
});

test("an https:// URL for an agent from before 0.7.0 says why it fails", async () => {
  const h = sim.host("sim-4");
  await sim.scenario("sim-4", { agent_tls: false });
  const r = await c.post("/api/test-connection", { ollama_url: h.ollama_url, agent_url: h.agent_https_url, agent_token: h.agent_token });
  assert.equal(r.data.agent.ok, false);
  assert.match(r.data.agent.detail, /before 0\.7\.0/);
  await sim.scenario("sim-4", { agent_tls: true });
});
