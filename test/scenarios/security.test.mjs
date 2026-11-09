// Security checks (#83): the dashboard checks each host (Ollama answering without a key, agents over plain
// HTTP or with weak tokens) and itself (initial passwords, plain HTTP, data file modes, tokens without
// expiry), says how to fix each failure, lets a failure be dismissed, and raises the
// "insecure" alert while a check fails, so a host that slips back sends a notification.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;
const TOKEN = "a-long-agent-token-for-the-security-scenario";

before(async () => {
  stack = holder.stack = await startStack({
    sim: { hosts: 3, ollamaKey: ",proxy-key-two,", agentToken: TOKEN },
    data: (s) => ({
      instances: {
        "sim-2": { agent_url: s.host("sim-2").agent_https_url },
        "sim-3": { agent_token: "change-me" },
      },
    }),
  });
  ({ client: c, sim } = stack);
  // fire and resolve at once, so the test doesn't wait for the defaults
  const rules = (await c.get("/api/alerts/rules")).data.rules.map((r) => (r.kind === "insecure" ? { ...r, for_s: 0, clear_s: 0 } : { ...r, enabled: false }));
  assert.equal((await c.put("/api/alerts/rules", { rules })).status, 200);
});
after(() => holder.stack?.stop());

const report = async () => {
  const r = await c.get("/api/security");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const checkOf = (rep, instance, id) => rep.targets.find((t) => t.instance === instance)?.checks.find((x) => x.id === id);

/** Wait until a check reaches `state`; returns it. */
async function waitCheck(instance, id, state, timeout = 30_000) {
  let seen;
  return waitFor(async () => {
    seen = checkOf(await report(), instance, id);
    return seen?.state === state && seen;
  }, { timeout, what: `${instance} ${id} to be ${state}`, describe: () => seen });
}

const alertOf = async (instance, subject) =>
  (await c.get("/api/alerts")).data.active.find((a) => a.kind === "insecure" && a.instance === instance && a.subject === subject);

test("a host without a proxy key whose Ollama listens beyond loopback fails, and says how to fix it", async () => {
  const x = await waitCheck("sim-1", "ollama_open", "fail");
  assert.match(x.detail, /OLLAMA_HOST binds every interface:11434/);
  assert.match(x.fix.doc, /^security-checks\.md#ollama-answers-without-a-key$/);
  const a = await waitFor(() => alertOf("sim-1", "ollama_open").then((y) => y?.state === "firing" && y), { what: "the alert to fire" });
  assert.match(a.detail, /^Ollama answers without a key: /);
});

test("an http:// agent that serves HTTPS fails; an https:// one passes", async () => {
  const x = await waitCheck("sim-1", "agent_http", "fail");
  assert.match(x.detail, /serves HTTPS/);
  // a config.yaml host can't be switched from the dashboard
  assert.equal(x.fix.action, undefined);
  assert.match(x.fix.label, /config\.yaml/);
  await waitCheck("sim-2", "agent_http", "pass");
});

test("a proxy that stops checking the key fails the host, and the alert resolves once it checks again", async () => {
  await waitCheck("sim-2", "ollama_open", "pass");
  await sim.scenario("sim-2", { ollama_key: null });
  const x = await waitCheck("sim-2", "ollama_open", "fail", 45_000);
  assert.match(x.detail, /answers without the proxy key/);
  await waitFor(() => alertOf("sim-2", "ollama_open").then((y) => y?.state === "firing"), { what: "the alert to fire" });

  await sim.scenario("sim-2", { ollama_key: "proxy-key-two" });
  await waitCheck("sim-2", "ollama_open", "pass", 45_000);
  await waitFor(async () => !(await alertOf("sim-2", "ollama_open")), { what: "the alert to resolve" });
});

test("a placeholder agent token fails; dismissing it stops it counting and alerting", async () => {
  const x = await waitCheck("sim-3", "agent_token", "fail");
  assert.match(x.detail, /placeholder/);
  await waitFor(() => alertOf("sim-3", "agent_token").then((y) => y?.state === "firing"), { what: "the alert to fire" });
  await waitCheck("sim-1", "agent_token", "pass");

  const before = (await report()).failing;
  assert.equal((await c.post("/api/security/dismissals", { instance: "nope", check: "agent_token" })).status, 400);
  assert.equal((await c.post("/api/security/dismissals", { instance: "sim-3", check: "data_files" })).status, 400, "a dashboard check on a host");
  const r = await c.post("/api/security/dismissals", { instance: "sim-3", check: "agent_token" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.dismissal.user, "admin");

  const d = await waitCheck("sim-3", "agent_token", "dismissed");
  assert.equal((await report()).failing, before - 1);
  await waitFor(async () => !(await alertOf("sim-3", "agent_token")), { what: "the alert to resolve" });
  const file = path.join(stack.data.data, "security-dismissals.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal((await c.del("/api/security/dismissals/sim-3/agent_token")).status, 200);
  assert.equal((await c.del("/api/security/dismissals/sim-3/agent_token")).status, 404);
  await waitCheck("sim-3", "agent_token", "fail");
  const audit = (await c.get("/api/audit?limit=20")).data.entries.map((e) => e.action);
  assert.ok(audit.includes("security.dismiss") && audit.includes("security.undismiss"), audit.join(", "));
});

test("the dashboard: a changed password passes; tokens without expiry fail", async () => {
  await waitCheck("@dashboard", "default_password", "pass");
  await waitCheck("@dashboard", "api_tokens", "pass");
  const t = await c.post("/api/tokens", { name: "forever", scopes: ["api:read"], expires_days: null });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const x = await waitCheck("@dashboard", "api_tokens", "fail");
  assert.equal(x.fix.href, "/tokens");
  await waitFor(() => alertOf("@dashboard", "api_tokens").then((y) => y?.state === "firing"), { what: "the dashboard's alert to fire" });
  assert.equal((await c.del(`/api/tokens/${t.data.id}`)).status, 200);
  await waitCheck("@dashboard", "api_tokens", "pass");
});

test("data files readable by others fail, and the fix makes them private", async () => {
  await waitCheck("@dashboard", "data_files", "pass");
  const file = path.join(stack.data.data, "alert-rules.json");
  fs.chmodSync(file, 0o644);
  const x = await waitCheck("@dashboard", "data_files", "fail");
  assert.match(x.detail, /alert-rules\.json \(644\)/);
  assert.equal(x.fix.action, "chmod_data");
  const r = await c.post("/api/security/fix", { check: "data_files" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changed, ["alert-rules.json"]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await waitCheck("@dashboard", "data_files", "pass");
});

test("the dashboard reached over plain HTTP from another name fails; loopback requests don't count", async () => {
  const x = await waitCheck("@dashboard", "dashboard_http", "unknown");
  assert.match(x.detail, /Not yet reached/);
  // what a browser on the LAN would send; the address itself stays loopback
  await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: stack.dashboard.port, path: "/api/auth/me", headers: { Host: `192.168.30.5:${stack.dashboard.port}` } }, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
  const y = await waitCheck("@dashboard", "dashboard_http", "fail");
  assert.match(y.detail, /plain HTTP as 192\.168\.30\.5/);
  const s = (await c.get("/api/instances")).data.security;
  assert.ok(s.failing >= 1, JSON.stringify(s));
});
