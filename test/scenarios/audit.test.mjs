// Audit log (#85): every change records who made it (session or API token), from where, to which host
// and what, with a short detail that never holds prompts, passwords, tokens or env values. Only admins
// read it; it can be filtered by user, host and action, and is kept for audit_retention_days.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, USERNAME, scenarioTest, startDashboard, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 1 }, data: { extra: "audit_retention_days: 10" } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

const log = async (query = "", client = c) => {
  const r = await client.get(`/api/audit${query}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
/** The newest entry with this action. */
const latest = async (action) => (await log(`?action=${action}`)).entries[0];

async function bearer(token, p) {
  const r = await fetch(stack.dashboard.url + p, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, data: await r.json() };
}

test("sign-ins are recorded; a failed one names only a real account", async () => {
  const ok = await latest("auth.login");
  assert.equal(ok.user, USERNAME);
  assert.equal(ok.credential, null);
  assert.ok(ok.ip);

  const anon = new Client(stack.dashboard.url);
  assert.equal((await anon.post("/api/auth/login", { username: USERNAME, password: "not-it" })).status, 401);
  // someone typing their password into the username field
  assert.equal((await anon.post("/api/auth/login", { username: "hunter2-typed-here", password: "x" })).status, 401);

  // the harness's first sign-in tries the final password before the initial one, so that failed too
  const failed = (await log("?action=auth.login_failed")).entries;
  assert.deepEqual(failed.map((e) => [e.user, e.detail]), [[null, "unknown username"], [USERNAME, "wrong password"], [USERNAME, "wrong password"]]);
  assert.equal(JSON.stringify(await log()).includes("hunter2"), false, "the typed text is never stored");
});

test("an env change records which keys changed, never their values", async () => {
  const secret = "https://secret-origin.example";
  const r = await c.put("/api/instances/sim-1/env", { vars: { OLLAMA_ORIGINS: secret, OLLAMA_KEEP_ALIVE: "10m" }, restart: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const e = await latest("env.change");
  assert.equal(e.instance, "sim-1");
  assert.equal(e.instance_name, "sim-1");
  assert.equal(e.user, USERNAME);
  // the simulator starts with OLLAMA_HOST and OLLAMA_KEEP_ALIVE set
  assert.equal(e.detail, "set OLLAMA_ORIGINS; changed OLLAMA_KEEP_ALIVE; unset OLLAMA_HOST; not restarted");

  assert.equal((await c.put("/api/instances/sim-1/env", { vars: { OLLAMA_KEEP_ALIVE: "20m" }, restart: false })).status, 200);
  assert.equal((await latest("env.change")).detail, "changed OLLAMA_KEEP_ALIVE; unset OLLAMA_ORIGINS; not restarted");

  const all = JSON.stringify(await log());
  assert.equal(all.includes("secret-origin"), false);
  assert.equal(all.includes("20m"), false);
});

test("model, restart and alert changes are recorded; a failed change isn't", async () => {
  assert.equal((await c.post("/api/instances/sim-1/models/copy", { source: "llama3.2:3b", destination: "audit-copy" })).status, 200);
  assert.equal((await c.post("/api/instances/sim-1/models/delete", { model: "audit-copy" })).status, 200);
  assert.equal((await c.post("/api/instances/sim-1/models/delete", { model: "no-such-model" })).status >= 400, true);
  const models = (await log("?action=model")).entries;
  assert.deepEqual(models.map((e) => [e.action, e.target, e.detail]), [
    ["model.delete", "audit-copy", ""],
    ["model.copy", "audit-copy", "from llama3.2:3b"],
  ]);

  assert.equal((await c.post("/api/instances/sim-1/restart")).status, 200);
  assert.equal((await latest("ollama.restart")).instance, "sim-1");

  const rules = (await c.get("/api/alerts/rules")).data.rules;
  const gpu = rules.find((r) => r.kind === "gpu_temp");
  assert.equal((await c.put("/api/alerts/rules", { rules: rules.map((r) => (r === gpu ? { ...r, threshold: 77 } : r)) })).status, 200);
  assert.equal((await latest("alert.rules")).detail, `changed ${gpu.name}`);
  // saving the same list again changes nothing, so nothing is recorded
  const count = (await log("?action=alert.rules")).entries.length;
  assert.equal((await c.put("/api/alerts/rules", { rules: (await c.get("/api/alerts/rules")).data.rules })).status, 200);
  assert.equal((await log("?action=alert.rules")).entries.length, count);

  const s = await c.post("/api/alerts/silences", { instance: "sim-1", duration_s: 3600, note: "maintenance" });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal((await latest("alert.silence")).detail, "for 1h 0m");
  assert.equal((await c.del(`/api/alerts/silences/${s.data.silence.id}`)).status, 200);
  assert.equal((await latest("alert.unsilence")).instance, "sim-1");
});

test("hosts added in the UI: edits list what changed and only say a token changed", async () => {
  const h = sim.hosts[0];
  const add = await c.post("/api/instances", { name: "audit-host", ollama_url: h.ollama_url, agent_url: h.agent_url, agent_token: h.agent_token });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  const id = add.data.id;
  assert.match((await latest("host.add")).detail, /agent .* with a token/);

  const put = await c.put(`/api/instances/${id}`, { name: "audit-host-2", ollama_url: h.ollama_url, agent_url: h.agent_url, agent_token: "a-new-agent-token-value" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const edit = await latest("host.edit");
  assert.equal(edit.detail, "name audit-host → audit-host-2; agent token changed");
  assert.equal(edit.instance_name, "audit-host-2");

  assert.equal((await c.del(`/api/instances/${id}`)).status, 200);
  const removed = await latest("host.remove");
  assert.equal(removed.instance, id);
  assert.equal(removed.instance_name, "audit-host-2", "the name outlives the host");

  const all = JSON.stringify(await log());
  assert.equal(all.includes("a-new-agent-token-value"), false);
  assert.equal(all.includes(h.agent_token), false);
});

test("benchmarks started and cancelled are recorded", async () => {
  const r = await c.post("/api/benchmarks", { model: "llama3.2:3b", instances: ["sim-1"], num_ctx: 512, repeat: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [b] = r.data.benchmarks;
  assert.equal((await c.del(`/api/benchmarks/${b.id}`)).status, 200);
  const entries = (await log("?action=benchmark")).entries;
  assert.equal(entries[1].action, "benchmark.start");
  assert.equal(entries[1].target, "llama3.2:3b");
  assert.match(entries[1].detail, new RegExp(`^${b.id}: `));
  assert.match(entries[0].action, /^benchmark\.(cancel|delete)$/, "cancelled, or deleted if it had already finished");
});

let viewer, viewerToken, adminToken;

test("account and token changes are recorded, and a token's requests name the token", async () => {
  const add = await c.post("/api/users", { username: "audit-viewer", role: "viewer" });
  assert.equal(add.status, 201);
  assert.equal((await latest("user.add")).detail, "role viewer");
  assert.equal((await c.put("/api/users/audit-viewer", { role: "admin" })).status, 200);
  assert.equal((await latest("user.role")).detail, "viewer → admin");
  assert.equal((await c.put("/api/users/audit-viewer", { role: "viewer" })).status, 200);
  assert.equal((await latest("user.role")).detail, "admin → viewer");
  const reset = await c.post("/api/users/audit-viewer/reset");
  assert.equal(reset.status, 200);
  assert.equal((await latest("user.reset")).target, "audit-viewer");

  viewer = new Client(stack.dashboard.url);
  let r = await viewer.post("/api/auth/login", { username: "audit-viewer", password: reset.data.password });
  assert.equal(r.status, 200);
  assert.equal((await viewer.post("/api/auth/password", { password: "viewer-password-1" })).status, 200);
  assert.equal((await latest("auth.password")).user, "audit-viewer");
  assert.equal(JSON.stringify(await log()).includes(reset.data.password), false, "no passwords");

  r = await viewer.post("/api/tokens", { name: "viewer-script", scopes: ["api:read"] });
  assert.equal(r.status, 201);
  viewerToken = r.data;
  r = await c.post("/api/tokens", { name: "admin-script", scopes: ["api:read", "api:write"] });
  assert.equal(r.status, 201);
  adminToken = r.data;
  const created = (await log("?action=token.create")).entries;
  assert.deepEqual(created.map((e) => [e.user, e.target]), [[USERNAME, "admin-script"], ["audit-viewer", "viewer-script"]]);
  assert.equal(JSON.stringify(created).includes(adminToken.token.slice(-43)), false, "no token secrets");

  // a change made with a token
  const w = await fetch(stack.dashboard.url + "/api/instances/sim-1/models/unload", {
    method: "POST", headers: { Authorization: `Bearer ${adminToken.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "llama3.2:3b" }),
  });
  assert.equal(w.status, 200, await w.text());
  const byToken = await latest("model.unload");
  assert.equal(byToken.user, USERNAME);
  assert.equal(byToken.credential, "admin-script");
  assert.equal(byToken.credential_id, adminToken.id);
});

test("only admins read the log, with a session or a token", async () => {
  assert.equal((await viewer.get("/api/audit")).status, 403);
  assert.equal((await bearer(viewerToken.token, "/api/audit")).status, 403);
  const page = await fetch(stack.dashboard.url + "/audit", { headers: { Cookie: viewer.cookie }, redirect: "manual" });
  assert.equal(page.status, 307, "the page sends viewers home");

  const r = await bearer(adminToken.token, "/api/audit?limit=5");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.entries.length, 5);
});

test("filters by user, host and action, and pages with ?before=", async () => {
  const byViewer = (await log("?user=audit-viewer")).entries;
  assert.ok(byViewer.length >= 3);
  assert.ok(byViewer.every((e) => e.user === "audit-viewer"));

  const byHost = (await log("?instance=sim-1")).entries;
  assert.ok(byHost.length >= 5);
  assert.ok(byHost.every((e) => e.instance === "sim-1"));

  const users = (await log("?action=user")).entries;
  assert.ok(users.length >= 4 && users.every((e) => e.action.startsWith("user.")));

  const facets = await log("?limit=1");
  assert.ok(facets.users.includes("audit-viewer"));
  assert.ok(facets.instances.some((i) => i.id === "sim-1"));

  const all = (await log("?limit=500")).entries;
  const first = await log("?limit=3");
  assert.deepEqual(first.entries.map((e) => e.id), all.slice(0, 3).map((e) => e.id));
  const second = await log(`?limit=3&before=${first.next}`);
  assert.deepEqual(second.entries.map((e) => e.id), all.slice(3, 6).map((e) => e.id));

  for (const bad of ["?limit=0", "?limit=501", "?before=x", "?action=nope", "?action=model.nope"]) {
    assert.equal((await c.get(`/api/audit${bad}`)).status, 400, bad);
  }
});

test("revoking a token and removing a user are recorded", async () => {
  assert.equal((await c.del(`/api/tokens/${viewerToken.id}`)).status, 200);
  const revoked = await latest("token.revoke");
  assert.equal(revoked.target, "viewer-script");
  assert.match(revoked.detail, /owned by audit-viewer/);
  assert.equal((await c.del("/api/users/audit-viewer")).status, 200);
  assert.equal((await latest("user.remove")).detail, "was viewer; their tokens were revoked");
});

test("the log survives a restart, and entries past audit_retention_days are dropped", async () => {
  const before = (await log("?limit=500")).entries.length;
  await stack.dashboard.stop();
  const db = new DatabaseSync(path.join(stack.data.data, "paddock.db"));
  const add = db.prepare("INSERT INTO audit (t, user, action, detail) VALUES (?, 'old-admin', 'host.add', '')");
  add.run(Date.now() / 1000 - 11 * 86400); // past the 10 days set above
  add.run(Date.now() / 1000 - 9 * 86400);
  db.close();

  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  c = stack.client = await new Client(stack.dashboard.url).login();
  // the poller trims on its first round
  await waitFor(async () => (await log("?user=old-admin")).entries.length === 1, { what: "the old entry to be trimmed" });
  // the earlier entries plus this sign-in and the newer seeded one
  assert.equal((await log("?limit=500")).entries.length, before + 2);
});
