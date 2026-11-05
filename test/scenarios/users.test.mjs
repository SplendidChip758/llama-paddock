// User accounts (#10): the old single login becomes the first admin, admins manage accounts, and a
// viewer can read everything but every request that changes something is refused on the server,
// whatever the UI shows. Role changes apply at once; a reset or removal signs the user out.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, PASSWORD, USERNAME, scenarioTest, startStack } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

/** auth.json as dashboards before user accounts wrote it, with the scenario password already chosen. */
function legacyAuth(dataDir) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(PASSWORD, salt, 32);
  const legacy = {
    username: USERNAME,
    hash: `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`,
    must_change: false,
    secret: crypto.randomBytes(32).toString("base64url"),
    version: 3,
  };
  fs.writeFileSync(path.join(dataDir.data, "auth.json"), JSON.stringify(legacy), { mode: 0o600 });
}

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 1 }, seed: legacyAuth });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

/** Sign in as `username`, choosing `newPassword` when the account still has a temporary one. */
async function signIn(username, password, newPassword) {
  const client = new Client(stack.dashboard.url);
  const r = await client.post("/api/auth/login", { username, password });
  assert.equal(r.status, 200, `login as ${username}: ${JSON.stringify(r.data)}`);
  if (r.data.must_change) {
    assert.equal((await client.get("/api/instances")).status, 403, "nothing but the password change until it is done");
    const p = await client.post("/api/auth/password", { password: newPassword });
    assert.equal(p.status, 200, JSON.stringify(p.data));
  }
  return client;
}

const addUser = async (username, role) => {
  const r = await c.post("/api/users", { username, role });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.password;
};

let viewer;

test("the old single login is migrated to the first admin", async () => {
  const me = await c.get("/api/auth/me");
  assert.equal(me.data.username, USERNAME);
  assert.equal(me.data.role, "admin");
  const stored = JSON.parse(fs.readFileSync(path.join(stack.data.data, "auth.json"), "utf8"));
  assert.equal(stored.users.length, 1);
  assert.equal(stored.users[0].role, "admin");
  assert.equal(stored.username, undefined, "the old top-level fields are gone");
  assert.equal(fs.statSync(path.join(stack.data.data, "auth.json")).mode & 0o777, 0o600);

  const list = await c.get("/api/users");
  assert.deepEqual(list.data.users, [{ username: USERNAME, role: "admin", must_change: false }]);
  assert.equal(JSON.stringify(list.data).includes("scrypt"), false, "hashes never reach the browser");
});

test("an admin adds a viewer, who signs in with the temporary password and must replace it", async () => {
  const temp = await addUser("viewer1", "viewer");
  assert.ok(temp.length >= 12);
  assert.equal((await c.post("/api/users", { username: "Viewer1", role: "admin" })).status, 409, "usernames ignore case");
  assert.equal((await c.post("/api/users", { username: "no spaces", role: "viewer" })).status, 400);
  assert.equal((await c.post("/api/users", { username: "x", role: "owner" })).status, 400);
  assert.equal((await new Client(stack.dashboard.url).post("/api/auth/login", { username: "nobody", password: temp })).status, 401);

  viewer = await signIn("viewer1", temp, "viewer-password-1");
  const me = await viewer.get("/api/auth/me");
  assert.equal(me.data.role, "viewer");
  assert.equal(me.data.must_change, false);
});

test("a viewer can read the fleet, logs, history and model details", async () => {
  for (const p of ["/api/instances", "/api/instances/sim-1/models", "/api/instances/sim-1/history", "/api/instances/sim-1/env",
    "/api/alerts", "/api/alerts/rules", "/api/jobs", "/api/uptime"]) {
    const r = await viewer.get(p);
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.data)}`);
  }
  assert.equal((await viewer.post("/api/instances/sim-1/models/show", { model: "llama3.2:3b" })).status, 200);
  assert.equal((await viewer.post("/api/instances/sim-1/gpu-check")).status, 200, "checking again changes nothing");
});

test("every request from a viewer that changes something is refused", async () => {
  const restartsBefore = (await sim.state("sim-1")).restarts;
  const writes = [
    ["POST", "/api/instances", { name: "x", ollama_url: "http://192.168.30.9:11434" }],
    ["PUT", "/api/instances/sim-1", { name: "renamed" }],
    ["DELETE", "/api/instances/sim-1"],
    ["POST", "/api/instances/sim-1/restart"],
    ["POST", "/api/instances/sim-1/models/pull", { model: "phi3:mini" }],
    ["POST", "/api/instances/sim-1/models/delete", { model: "llama3.2:3b" }],
    ["POST", "/api/instances/sim-1/models/unload", { model: "llama3.2:3b" }],
    ["POST", "/api/instances/sim-1/models/copy", { source: "llama3.2:3b", destination: "copy:latest" }],
    ["POST", "/api/instances/sim-1/models/create", { model: "x:latest", from: "llama3.2:3b" }],
    ["PUT", "/api/instances/sim-1/env", { vars: { OLLAMA_KEEP_ALIVE: "1h" } }],
    ["POST", "/api/instances/sim-1/gpu-check/fix", { action: "restart" }],
    ["POST", "/api/instances/sim-1/agent-key", { fingerprint: "x" }],
    ["POST", "/api/instances/sim-1/agent-https"],
    ["PUT", "/api/alerts/rules", { rules: [] }],
    ["PUT", "/api/alerts/channels", { channels: [] }],
    ["POST", "/api/alerts/channels/test", { channel: {} }],
    ["POST", "/api/alerts/silences", { instance: "sim-1", duration_s: 60 }],
    ["DELETE", "/api/alerts/silences/1"],
    ["DELETE", "/api/jobs/x"],
    ["PUT", "/api/request-clients", { names: {} }],
    ["POST", "/api/test-connection", { ollama_url: "http://192.168.30.9:11434" }],
    ["POST", "/api/users", { username: "sneaky", role: "admin" }],
    ["PUT", "/api/users/viewer1", { role: "admin" }],
    ["POST", "/api/users/admin/reset"],
    ["DELETE", "/api/users/admin"],
  ];
  for (const [method, p, body] of writes) {
    const r = await viewer.request(method, p, body ?? (method === "DELETE" ? undefined : {}));
    assert.equal(r.status, 403, `${method} ${p}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  // the user list is for admins only, however the path is spelled
  for (const p of ["/api/users", "/api/%75sers", "/users"]) {
    const r = await viewer.get(p);
    assert.ok(r.status !== 200 || !JSON.stringify(r.data).includes("viewer1"), `${p} must not list users: ${r.status}`);
  }

  const i = await viewer.instance("sim-1");
  assert.equal(i.name, "sim-1", "the host is unchanged");
  assert.equal((await sim.state("sim-1")).restarts, restartsBefore, "Ollama was not restarted");
  assert.equal((await c.get("/api/users")).data.users.length, 2, "no user was added or removed");
});

test("a viewer can still change their own password and sign out", async () => {
  const r = await viewer.post("/api/auth/password", { current: "viewer-password-1", password: "viewer-password-2" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await viewer.get("/api/instances")).status, 200, "the new session cookie works");
});

test("a role change applies to a signed-in user at once", async () => {
  assert.equal((await c.put("/api/users/viewer1", { role: "admin" })).status, 200);
  assert.equal((await viewer.put("/api/request-clients", { names: {} })).status, 200);
  assert.equal((await c.put("/api/users/VIEWER1", { role: "viewer" })).status, 200, "names are matched without case");
  assert.equal((await viewer.put("/api/request-clients", { names: {} })).status, 403);
});

test("an admin can't demote, reset or remove their own account", async () => {
  assert.equal((await c.put(`/api/users/${USERNAME}`, { role: "viewer" })).status, 400);
  assert.equal((await c.post(`/api/users/${USERNAME}/reset`)).status, 400);
  assert.equal((await c.del(`/api/users/${USERNAME}`)).status, 400);
  assert.equal((await c.get("/api/auth/me")).data.role, "admin");
});

test("a password reset signs the user out and hands over a new temporary password", async () => {
  const r = await c.post("/api/users/viewer1/reset");
  assert.equal(r.status, 200);
  assert.equal((await viewer.get("/api/instances")).status, 401, "the old session is gone");
  assert.equal((await c.get("/api/users")).data.users.find((u) => u.username === "viewer1").must_change, true);
  viewer = await signIn("viewer1", r.data.password, "viewer-password-3");
});

test("removing a user signs them out, and a new account with the same name doesn't inherit the session", async () => {
  assert.equal((await c.del("/api/users/viewer1")).status, 200);
  assert.equal((await viewer.get("/api/instances")).status, 401);
  assert.equal((await c.del("/api/users/viewer1")).status, 404);

  await addUser("viewer1", "admin");
  assert.equal((await viewer.get("/api/instances")).status, 401, "the removed account's cookie stays invalid");
  assert.equal((await viewer.put("/api/request-clients", { names: {} })).status, 401);
});
