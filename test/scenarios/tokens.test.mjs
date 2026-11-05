// API tokens (#84): scripts call /api with `Authorization: Bearer`. A token carries scopes that its user's
// role allows; it never does more than its user can now, never regains what a role change took away, and
// dies with its user. Accounts and tokens are managed from a browser session only. Failed tokens lock out
// their address like failed logins, on their own count.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, scenarioTest, startStack } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 1 } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

/** A request with a bearer token, from `ip` (the dashboard trusts no proxy, so the last X-Forwarded-For entry is the address). */
async function call(token, method, p, body, { ip = "192.168.30.50", cookie } = {}) {
  const headers = { Authorization: `Bearer ${token}`, "X-Forwarded-For": ip };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(stack.dashboard.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, data, headers: r.headers };
}

const credsFile = () => path.join(stack.data.data, "credentials.json");
const stored = () => JSON.parse(fs.readFileSync(credsFile(), "utf8")).credentials;

async function newToken(client, body) {
  const r = await client.post("/api/tokens", { name: "t", ...body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

async function signIn(username, password, newPassword) {
  const client = new Client(stack.dashboard.url);
  const r = await client.post("/api/auth/login", { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (r.data.must_change) assert.equal((await client.post("/api/auth/password", { password: newPassword })).status, 200);
  return client;
}

let readTok, writeTok;

test("a token is shown once and only its hash is stored", async () => {
  readTok = await newToken(c, { name: "home-assistant", scopes: ["api:read"], expires_days: 30 });
  assert.match(readTok.token, /^paddock_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  assert.equal(readTok.kind, "api");
  assert.deepEqual(readTok.scopes, ["api:read"]);
  assert.ok(Date.parse(readTok.expires) > Date.now() + 29 * 86400_000);

  const list = await c.get("/api/tokens");
  assert.equal(list.status, 200);
  assert.equal(list.data.tokens.length, 1);
  assert.equal(list.data.tokens[0].name, "home-assistant");
  assert.equal(JSON.stringify(list.data).includes(readTok.token.slice(-43)), false, "the secret is never listed");
  assert.equal(JSON.stringify(list.data).includes("sha256"), false, "nor its hash");

  const file = fs.readFileSync(credsFile(), "utf8");
  assert.equal(file.includes(readTok.token.slice(-43)), false, "the secret isn't stored");
  assert.equal(fs.statSync(credsFile()).mode & 0o777, 0o600);
});

test("a read token reads the fleet and nothing it can change", async () => {
  for (const p of ["/api/instances", "/api/instances/sim-1/history", "/api/alerts", "/api/jobs", "/api/uptime"]) {
    const r = await call(readTok.token, "GET", p);
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.data)}`);
  }
  assert.equal((await call(readTok.token, "POST", "/api/instances/sim-1/models/show", { model: "llama3.2:3b" })).status, 200);

  const me = await call(readTok.token, "GET", "/api/auth/me");
  assert.equal(me.data.username, "admin");
  assert.deepEqual(me.data.token, { id: readTok.id, kind: "api", name: "home-assistant", scopes: ["api:read"] });

  const restarts = (await sim.state("sim-1")).restarts;
  for (const [method, p, body] of [
    ["POST", "/api/instances/sim-1/restart", {}],
    ["PUT", "/api/request-clients", { names: {} }],
    ["POST", "/api/instances/sim-1/models/pull", { model: "phi3:mini" }],
    ["DELETE", "/api/instances/sim-1"],
  ]) {
    const r = await call(readTok.token, method, p, body);
    assert.equal(r.status, 403, `${method} ${p}: ${r.status}`);
    assert.equal(r.data.code, "forbidden");
    assert.equal(r.data.scope, "api:write");
  }
  assert.equal((await sim.state("sim-1")).restarts, restarts, "Ollama was not restarted");
});

test("an admin's write token can change things", async () => {
  writeTok = await newToken(c, { name: "cron", scopes: ["api:read", "api:write"] });
  assert.equal(writeTok.expires, null, "no expiry unless asked");
  assert.equal((await call(writeTok.token, "PUT", "/api/request-clients", { names: {} })).status, 200);
  const restarts = (await sim.state("sim-1")).restarts;
  const r = await call(writeTok.token, "POST", "/api/instances/sim-1/restart", {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await sim.state("sim-1")).restarts, restarts + 1);
});

test("the bearer token decides, whatever session cookie comes with it", async () => {
  const r = await call(readTok.token, "PUT", "/api/request-clients", { names: {} }, { cookie: c.cookie });
  assert.equal(r.status, 403, "an admin cookie doesn't lift a read token's limits");
});

test("tokens can't manage accounts, tokens or passwords", async () => {
  for (const [method, p, body] of [
    ["GET", "/api/users"],
    ["GET", "/api/%75sers"],
    ["POST", "/api/users", { username: "sneaky", role: "admin" }],
    ["GET", "/api/tokens"],
    ["POST", "/api/tokens", { name: "x", scopes: ["api:read"] }],
    ["DELETE", `/api/tokens/${readTok.id}`],
    ["POST", "/api/auth/password", { password: "whatever-password" }],
    ["POST", "/api/auth/logout", {}],
  ]) {
    const r = await call(writeTok.token, method, p, body);
    assert.equal(r.status, 403, `${method} ${p}: ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, "session_only");
  }
  assert.equal((await c.get("/api/tokens")).data.tokens.length, 2, "no token was created or revoked");
  // pages are for browsers
  assert.equal((await call(writeTok.token, "GET", "/")).status, 403);
});

test("failed tokens lock out their address, without touching the login or other addresses", async () => {
  const ip = "192.168.30.61";
  const wrong = readTok.token.slice(0, -4) + "AAAA";
  for (const bad of [wrong, "nonsense", "paddock_0000000000000000_" + "A".repeat(43), wrong, wrong]) {
    const r = await call(bad, "GET", "/api/instances", undefined, { ip });
    assert.equal(r.status, 401, JSON.stringify(r.data));
    assert.equal(r.data.code, "bad_token");
    assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer/);
  }
  const locked = await call(readTok.token, "GET", "/api/instances", undefined, { ip });
  assert.equal(locked.status, 429, "even a good token waits while its address is locked out");
  assert.ok(Number(locked.headers.get("retry-after")) > 0);

  assert.equal((await call(readTok.token, "GET", "/api/instances", undefined, { ip: "192.168.30.62" })).status, 200, "other addresses carry on");
  const login = await fetch(stack.dashboard.url + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify({ username: "admin", password: "wrong-password" }),
  });
  assert.equal(login.status, 401, "the login keeps its own count");
});

test("an expired token is refused, and doesn't count as a guess", async () => {
  const tok = await newToken(c, { name: "short", scopes: ["api:read"], expires_days: 1 });
  const file = JSON.parse(fs.readFileSync(credsFile(), "utf8"));
  file.credentials.find((x) => x.id === tok.id).expires = Math.floor(Date.now() / 1000) - 10;
  fs.writeFileSync(credsFile(), JSON.stringify(file), { mode: 0o600 });

  const ip = "192.168.30.63";
  for (let i = 0; i < 6; i++) {
    const r = await call(tok.token, "GET", "/api/instances", undefined, { ip });
    assert.equal(r.status, 401);
    assert.equal(r.data.detail, "token expired");
  }
  assert.equal((await call(readTok.token, "GET", "/api/instances", undefined, { ip })).status, 200, "a script with an expired token doesn't lock out its host");
  assert.equal((await c.get("/api/tokens")).data.tokens.find((t) => t.id === tok.id).expired, true);
  assert.equal((await c.del(`/api/tokens/${tok.id}`)).status, 200);
});

test("last use is recorded", async () => {
  const t = (await c.get("/api/tokens")).data.tokens.find((x) => x.id === readTok.id);
  assert.ok(t.last_used && Date.now() - Date.parse(t.last_used) < 120_000, JSON.stringify(t));
});

let viewer, viewerTok;

test("a viewer makes read tokens only, and only api tokens can be made yet", async () => {
  const add = await c.post("/api/users", { username: "viewer1", role: "viewer" });
  viewer = await signIn("viewer1", add.data.password, "viewer-password-1");

  const w = await viewer.post("/api/tokens", { name: "x", scopes: ["api:read", "api:write"] });
  assert.equal(w.status, 403, JSON.stringify(w.data));
  assert.equal((await viewer.post("/api/tokens", { name: "x", scopes: ["display:read"] })).status, 400, "an api token can't carry a display scope");
  assert.equal((await viewer.post("/api/tokens", { name: "x", kind: "display", scopes: ["display:read"] })).status, 400, "display links come with #11");
  assert.equal((await c.post("/api/tokens", { name: "x", kind: "gateway", scopes: ["gateway:invoke"] })).status, 400, "gateway keys come with M7");
  assert.equal((await viewer.post("/api/tokens", { name: "", scopes: ["api:read"] })).status, 400);
  assert.equal((await viewer.post("/api/tokens", { name: "x", scopes: ["api:read"], expires_days: 0 })).status, 400);
  assert.equal((await viewer.get("/api/tokens?all=1")).status, 403);

  viewerTok = await newToken(viewer, { name: "viewer-script", scopes: ["api:read"] });
  assert.equal((await call(viewerTok.token, "GET", "/api/instances")).status, 200);
  assert.equal((await call(viewerTok.token, "POST", "/api/instances/sim-1/restart", {})).status, 403);
  assert.deepEqual((await viewer.get("/api/tokens")).data.tokens.map((t) => t.name), ["viewer-script"], "a user sees only their own");
});

test("revoking: your own, or anyone's as an admin", async () => {
  assert.equal((await viewer.del(`/api/tokens/${readTok.id}`)).status, 404, "a viewer can't revoke someone else's");
  const everyone = await c.get("/api/tokens?all=1");
  assert.equal(everyone.data.tokens.find((t) => t.id === viewerTok.id).user, "viewer1");
  assert.equal((await c.del(`/api/tokens/${viewerTok.id}`)).status, 200);
  const r = await call(viewerTok.token, "GET", "/api/instances");
  assert.equal(r.status, 401);
  assert.equal((await c.del(`/api/tokens/${viewerTok.id}`)).status, 404);
});

test("a role change takes away what the new role can't do, for good", async () => {
  const add = await c.post("/api/users", { username: "ops", role: "admin" });
  const ops = await signIn("ops", add.data.password, "ops-password-1");
  const tok = await newToken(ops, { name: "ops-cron", scopes: ["api:read", "api:write"] });
  assert.equal((await call(tok.token, "PUT", "/api/request-clients", { names: {} })).status, 200);

  assert.equal((await c.put("/api/users/ops", { role: "viewer" })).status, 200);
  assert.equal((await call(tok.token, "PUT", "/api/request-clients", { names: {} })).status, 403, "applies at once");
  assert.deepEqual(stored().find((x) => x.id === tok.id).scopes, ["api:read"], "the write scope is gone from the record");
  assert.equal((await call(tok.token, "GET", "/api/instances")).status, 200, "reading still works");

  assert.equal((await c.put("/api/users/ops", { role: "admin" })).status, 200);
  assert.equal((await call(tok.token, "PUT", "/api/request-clients", { names: {} })).status, 403, "promoting again doesn't bring it back");
  assert.deepEqual((await call(tok.token, "GET", "/api/auth/me")).data.token.scopes, ["api:read"]);
});

test("a user's tokens are removed with the account", async () => {
  const tok = await newToken(viewer, { name: "doomed", scopes: ["api:read"] });
  assert.equal((await c.del("/api/users/viewer1")).status, 200);
  assert.equal((await call(tok.token, "GET", "/api/instances")).status, 401);
  assert.equal(stored().some((x) => x.id === tok.id), false);

  // a new account with the same name doesn't inherit them
  await c.post("/api/users", { username: "viewer1", role: "viewer" });
  assert.equal((await call(tok.token, "GET", "/api/instances")).status, 401);
});
