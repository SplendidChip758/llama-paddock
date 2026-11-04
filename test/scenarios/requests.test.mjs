// Request log (#73): the dashboard reads each host's requests from its agent, leaves out monitoring
// calls (its own polling among them), counts them per client, endpoint and model, matches a request
// to a model only when one model was loaded, and lets client addresses be named.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,1" } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
  await c.waitInstance("sim-2", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

/** Call a simulated Ollama as if from `client`. */
async function ollama(host, client, method, p, body) {
  const r = await fetch(sim.host(host).ollama_url + p, {
    method, headers: { "X-Sim-Client": client, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  await r.text();
  return r.status;
}
const generate = (host, client, model) => ollama(host, client, "POST", "/api/generate", { model, prompt: "hi", stream: false });
const summary = async (host, range = "1h") => {
  const r = await c.get(`/api/instances/${host}/requests?range=${range}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
/** The poller reads request logs every 10 polls; wait for at least `n` requests. */
const waitRequests = (host, n, what) => {
  let seen;
  return waitFor(async () => {
    seen = await summary(host);
    return seen.total.count >= n && seen;
  }, { timeout: 40_000, what: `${host}: ${what}`, describe: () => seen && { total: seen.total, sync: seen.sync } });
};

test("requests are counted per client and endpoint; the dashboard's own polling isn't stored", async () => {
  assert.equal(await generate("sim-1", "192.168.30.20", "llama3.2:3b"), 200);
  assert.equal(await generate("sim-1", "192.168.30.20", "llama3.2:3b"), 200);
  assert.equal(await generate("sim-1", "192.168.30.20", "llama3.2:3b"), 200);
  assert.equal(await ollama("sim-1", "192.168.30.21", "GET", "/api/tags"), 200);
  assert.equal(await ollama("sim-1", "192.168.30.21", "POST", "/api/show", { model: "no-such-model" }), 404);

  const s = await waitRequests("sim-1", 5, "five requests");
  // the dashboard's own calls that aren't monitoring (its context check's /api/show) are kept under its address
  const ours = s.clients.filter((x) => x.client.startsWith("192.168.30."));
  assert.equal(ours.reduce((n, x) => n + x.count, 0), 5, JSON.stringify(s.clients));
  assert.equal(ours.reduce((n, x) => n + x.errors, 0), 1);
  const by = Object.fromEntries(s.clients.map((x) => [x.client, x]));
  assert.equal(by["192.168.30.20"].count, 3);
  assert.equal(by["192.168.30.21"].count, 2);
  assert.equal(by["192.168.30.21"].errors, 1);
  assert.ok(!s.endpoints.some((e) => ["/api/ps", "/api/version"].includes(e.path)), "monitoring calls aren't stored");
  assert.deepEqual(s.endpoints.find((e) => e.path === "/api/generate")?.count, 3);
  assert.equal(s.buckets.reduce((n, b) => n + b.count, 0), s.total.count);
  assert.ok(s.slowest.length >= 5 && s.slowest[0].duration_ms >= s.slowest[4].duration_ms);
  assert.ok(s.sync.last_ok && s.sync.error === null && !s.sync.unsupported);
});

test("a request is matched to the model loaded then, but not when several are", async () => {
  const one = await waitFor(async () => {
    const s = await summary("sim-1");
    return s.models.find((m) => m.model === "llama3.2:3b") && s;
  }, { timeout: 40_000, what: "generate requests matched to llama3.2:3b" });
  assert.ok(one.recent.filter((r) => r.path === "/api/tags").every((r) => r.model === null), "listing models runs none");

  // a failed request didn't run on the loaded model
  assert.equal(await generate("sim-1", "192.168.30.21", "missing:1b"), 404);
  const failed = await waitFor(async () => (await summary("sim-1")).recent.find((r) => r.path === "/api/generate" && r.status === 404),
    { timeout: 40_000, what: "the failed generate request" });
  assert.equal(failed.model, null);

  // two models loaded on sim-2: which one answered isn't in the log
  assert.equal(await generate("sim-2", "192.168.30.22", "llama3.2:3b"), 200);
  assert.equal(await generate("sim-2", "192.168.30.22", "qwen2.5-coder:7b"), 200);
  await c.waitInstance("sim-2", (x) => x.ps.length === 2, "two models loaded");
  assert.equal(await generate("sim-2", "192.168.30.22", "llama3.2:3b"), 200);
  const s = await waitRequests("sim-2", 3, "three requests");
  const last = s.recent.find((r) => r.path === "/api/generate");
  assert.equal(last.model, null, JSON.stringify(s.recent));
});

test("client addresses can be named; names are checked and stored with mode 600", async () => {
  const bad = await c.put("/api/request-clients", { names: { "not an address": "x" } });
  assert.equal(bad.status, 400);
  const r = await c.put("/api/request-clients", { names: { "192.168.30.20": " open-webui ", "192.168.30.21": "" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.names, { "192.168.30.20": "open-webui" });
  const s = await summary("sim-1");
  assert.equal(s.clients.find((x) => x.client === "192.168.30.20").name, "open-webui");
  assert.equal(s.clients.find((x) => x.client === "192.168.30.21").name, null);
  assert.equal(fs.statSync(path.join(stack.data.data, "request-clients.json")).mode & 0o777, 0o600);
  assert.equal((await c.get("/api/instances/sim-1/requests?range=1y")).status, 400);
});

test("the log pages through every request in the range, latest or slowest first", async () => {
  const s = await summary("sim-1");
  const page = async (q) => {
    const r = await c.get(`/api/instances/sim-1/requests/log?range=1h&to=${s.to}&${q}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  // the earlier tests left at least 6 requests on sim-1, all read by now
  const first = await page("limit=2");
  assert.equal(first.total, s.total.count);
  assert.ok(first.total >= 6, `total ${first.total}`);
  assert.equal(first.requests.length, 2);
  const all = [];
  for (let offset = 0; offset < first.total; offset += 2) all.push(...(await page(`limit=2&offset=${offset}`)).requests);
  assert.equal(all.length, first.total, "the pages cover every request once");
  assert.deepEqual(all.map((r) => r.t), all.map((r) => r.t).sort((a, b) => b - a), "latest first");
  assert.deepEqual(all.slice(0, 2), first.requests);

  const slow = await page("sort=slowest&limit=100");
  assert.deepEqual(slow.requests.map((r) => r.duration_ms), slow.requests.map((r) => r.duration_ms).sort((a, b) => b - a));
  assert.equal(slow.requests[0].duration_ms, s.total.max_ms);

  for (const q of ["sort=fastest", "limit=0", "limit=101", "offset=-1", "range=1y", "to=soon"]) {
    assert.equal((await c.get(`/api/instances/sim-1/requests/log?${q}`)).status, 400, q);
  }
});
