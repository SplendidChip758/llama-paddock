// Configuration export and import (#87): an admin exports the setup, encrypted, after confirming
// their password; a fresh install imports it from the first-login screen, with a dry run first, and
// gets the hosts, users and API tokens without a restart. paddock-backup does the same from the shell.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  Client, INITIAL_PASSWORD, PASSWORD, REPO, USERNAME, makeDataDir, scenarioTest, startDashboard, startStack,
} from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
const CLI = path.join(REPO, "dashboard/bin/paddock-backup.mjs");
const PASSPHRASE = "correct horse battery";
let c, stack, fresh, token, exported;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 2 } });
  c = stack.client;
  const h = stack.sim.hosts[1];
  // the second host is added in the UI, so it lives in hosts.json with its agent token
  assert.equal((await c.post("/api/instances", { name: "added-in-ui", ollama_url: h.ollama_url, agent_url: h.agent_url, agent_token: h.agent_token })).status, 201);
  assert.equal((await c.post("/api/users", { username: "bob", role: "viewer" })).status, 201);
  const t = await c.post("/api/tokens", { name: "script", scopes: ["api:read"] });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  token = t.data.token;
  assert.equal((await c.put("/api/request-clients", { names: { "192.168.30.5": "open-webui" } })).status, 200);
});
after(async () => {
  await fresh?.dashboard.stop();
  fresh?.data.remove();
  await holder.stack?.stop();
});

function cli(dataDir, args, env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("PADDOCK_")) delete base[k];
  Object.assign(base, { PADDOCK_DATA_DIR: dataDir.data, PADDOCK_CONFIG: dataDir.config }, env);
  const r = spawnSync(process.execPath, [CLI, ...args], { env: base, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const bearer = (url, p) => fetch(url + p, { headers: { Authorization: `Bearer ${token}` } });

test("an export needs the admin's password, a browser session and a long enough passphrase", async () => {
  assert.equal((await c.post("/api/config/export", { passphrase: PASSPHRASE, password: "wrong" })).status, 400);
  assert.equal((await c.post("/api/config/export", { passphrase: "short", password: PASSWORD })).status, 400);
  assert.equal((await c.post("/api/config/export", { password: PASSWORD })).status, 400, "neither a passphrase nor unencrypted");
  const r = await fetch(`${stack.dashboard.url}/api/config/export`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(r.status, 403, "a token can't export");
});

test("the export is sealed with the passphrase and gives no secret away", async () => {
  const r = await c.post("/api/config/export", { passphrase: PASSPHRASE, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  exported = r.data;
  assert.equal(exported.encryption.kdf, "scrypt");
  assert.equal(exported.encryption.cipher, "aes-256-gcm");
  const text = JSON.stringify(exported);
  for (const secret of [stack.sim.hosts[1].agent_token, "bob", "open-webui", "added-in-ui"]) assert.ok(!text.includes(secret), `${secret} in the export`);
  const audit = await c.get("/api/audit?action=config.export");
  assert.ok(audit.data.entries.some((e) => e.action === "config.export"), JSON.stringify(audit.data));

  // unencrypted only when asked for, and then readable as it is
  const plain = await c.post("/api/config/export", { unencrypted: true, password: PASSWORD });
  assert.equal(plain.data.encryption, null);
  assert.ok(plain.data.config.users.some((u) => u.username === "bob"));
});

test("a fresh install imports it from the first-login screen: dry run first, then without a restart", async () => {
  fresh = { data: makeDataDir(stack.sim) };
  fresh.dashboard = await startDashboard(fresh.data);
  const b = new Client(fresh.dashboard.url);
  const login = await b.post("/api/auth/login", { username: USERNAME, password: INITIAL_PASSWORD });
  assert.equal(login.data.must_change, true);

  assert.match((await b.post("/api/config/import", { file: exported, dry_run: true })).data.detail, /passphrase/);
  assert.match((await b.post("/api/config/import", { file: exported, passphrase: "not the passphrase", dry_run: true })).data.detail, /wrong passphrase/);
  assert.match((await b.post("/api/config/import", { file: { hello: 1 }, dry_run: true })).data.detail, /isn't a llama-paddock/);

  const dry = await b.post("/api/config/import", { file: exported, passphrase: PASSPHRASE, dry_run: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.applied, false);
  const act = (section, label) => dry.data.items.find((i) => i.section === section && i.label.startsWith(label))?.action;
  assert.equal(act("hosts", "added-in-ui"), "add");
  assert.equal(act("users", "bob"), "add");
  assert.equal(act("users", "admin"), "replace", "the initial admin takes the exported password");
  assert.equal(act("tokens", "script"), "add");
  assert.equal(act("clients", "192.168.30.5"), "add");
  assert.equal(act("config", "config.yaml"), "skip", "the dashboard never writes config.yaml");
  assert.equal(fs.existsSync(path.join(fresh.data.data, "hosts.json")), false, "a dry run writes nothing");

  const r = await b.post("/api/config/import", { file: exported, passphrase: PASSPHRASE });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.applied, true);
  assert.equal(r.data.signed_out, true, "the admin account was replaced");
  for (const f of ["hosts.json", "auth.json", "credentials.json"]) assert.equal(fs.statSync(path.join(fresh.data.data, f)).mode & 0o777, 0o600, f);

  // what the import replaced can be restored: a pre-import backup was taken first
  const backups = path.join(fresh.data.data, "backups");
  const taken = fs.readdirSync(backups).filter((n) => n.endsWith("-pre-import"));
  assert.equal(taken.length, 1, fs.readdirSync(backups).join(" "));
  assert.equal(cli(fresh.data, ["verify", taken[0]]).code, 0);

  // the exported password signs in, with nothing left to change
  const again = await new Client(fresh.dashboard.url).login();
  assert.ok((await again.instance("added-in-ui")), "the imported host is polled without a restart");
  await again.waitInstance("added-in-ui", (x) => x.ollama_ok && x.agent_ok, "online with the imported agent token");
  assert.deepEqual((await again.get("/api/users")).data.users.map((u) => u.username).sort(), ["admin", "bob"]);
  assert.equal((await bearer(fresh.dashboard.url, "/api/auth/me")).status, 200, "the API token works on the new install");
  assert.equal((await again.get("/api/request-clients")).data.names["192.168.30.5"], "open-webui");
  const audit = await again.get("/api/audit?action=config.import");
  assert.ok(audit.data.entries.some((e) => e.action === "config.import"), JSON.stringify(audit.data));

  // importing the same file again changes nothing
  const twice = await again.post("/api/config/import", { file: exported, passphrase: PASSPHRASE, dry_run: true });
  assert.equal(twice.data.counts.add + twice.data.counts.replace, 0, JSON.stringify(twice.data.items.filter((i) => i.action !== "skip")));
  fresh.client = again;
});

test("viewers can't export or import", async () => {
  const viewer = new Client(fresh.dashboard.url);
  // bob came over with the temporary password the source handed out, which nobody knows here: reset it
  const reset = await fresh.client.post("/api/users/bob/reset");
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  await viewer.post("/api/auth/login", { username: "bob", password: reset.data.password });
  await viewer.post("/api/auth/password", { password: "bob-password-1" });
  assert.equal((await viewer.post("/api/config/export", { passphrase: PASSPHRASE, password: "bob-password-1" })).status, 403);
  assert.equal((await viewer.post("/api/config/import", { file: exported, passphrase: PASSPHRASE, dry_run: true })).status, 403);
});

test("paddock-backup exports and imports from the shell, and won't import into a running dashboard", async () => {
  const file = path.join(stack.data.dir, "export.json");
  let r = cli(stack.data, ["export", file], { PADDOCK_PASSPHRASE: PASSPHRASE });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(cli(stack.data, ["export", file], { PADDOCK_PASSPHRASE: PASSPHRASE }).code, 2, "never over an existing file");

  const target = makeDataDir(stack.sim);
  try {
    r = cli(target, ["import", file, "--dry-run", "--json"], { PADDOCK_PASSPHRASE: PASSPHRASE });
    assert.equal(r.code, 0, r.err);
    const plan = JSON.parse(r.out);
    assert.ok(plan.items.some((i) => i.section === "hosts" && i.label.startsWith("added-in-ui") && i.action === "add"), r.out);

    // the running fresh dashboard is in the way
    r = cli(fresh.data, ["import", file], { PADDOCK_PASSPHRASE: PASSPHRASE });
    assert.equal(r.code, 2);
    assert.match(r.err, /dashboard is running/);

    // a stopped one: only the hosts, and config.yaml when asked for
    fs.appendFileSync(target.config, "# changed here\n");
    r = cli(target, ["import", file, "--only", "hosts,config", "--config", "--json"], { PADDOCK_PASSPHRASE: PASSPHRASE });
    assert.equal(r.code, 0, r.err);
    const done = JSON.parse(r.out);
    assert.equal(done.applied, true);
    assert.ok(done.items.every((i) => ["hosts", "config"].includes(i.section)), r.out);
    assert.equal(fs.readFileSync(target.config, "utf8"), fs.readFileSync(stack.data.config, "utf8"));
    const hosts = JSON.parse(fs.readFileSync(path.join(target.data, "hosts.json"), "utf8")).instances;
    assert.deepEqual(hosts.map((h) => h.id), ["added-in-ui"]);
    assert.equal(hosts[0].agent_token, stack.sim.hosts[1].agent_token);
    assert.equal(fs.existsSync(path.join(target.data, "auth.json")), false, "users weren't asked for");

    r = cli(target, ["import", file, "--only", "nonsense"], { PADDOCK_PASSPHRASE: PASSPHRASE });
    assert.equal(r.code, 2);
    r = cli(target, ["import", file, "--dry-run"], { PADDOCK_PASSPHRASE: "wrong passphrase!" });
    assert.match(r.err, /wrong passphrase/);
  } finally {
    target.remove();
  }
});
