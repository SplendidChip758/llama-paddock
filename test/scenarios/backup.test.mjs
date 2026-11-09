// Full backups (#87): paddock-backup takes a consistent backup while the dashboard runs, refuses to
// restore over a running dashboard, a damaged backup or one from a newer version, and a restore puts
// back the database, the login and API data and config.yaml, and removes what was added since.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, REPO, scenarioTest, startDashboard, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
const CLI = path.join(REPO, "dashboard/bin/paddock-backup.mjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "dashboard/package.json"), "utf8")).version;
let c, stack, envFile, backups, first, pointsBefore;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 1 } });
  c = stack.client;
  envFile = path.join(stack.data.dir, "llama-paddock.env");
  fs.writeFileSync(envFile, "PADDOCK_USERNAME=admin\n", { mode: 0o600 });
  backups = path.join(stack.data.data, "backups");
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

function cli(...args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PADDOCK_")) delete env[k];
  Object.assign(env, { PADDOCK_DATA_DIR: stack.data.data, PADDOCK_CONFIG: stack.data.config, PADDOCK_ENV_FILE: envFile });
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const users = async (client = c) => (await client.get("/api/users")).data.users.map((u) => u.username).sort();
const points = async (client = c) => (await client.get("/api/instances/sim-1/history")).data.points.length;
const mode = (f) => fs.statSync(f).mode & 0o777;

test("a backup is taken while the dashboard runs, with versions and checksums", async () => {
  await waitFor(async () => (await points()) >= 3, { what: "a few history points" });
  assert.equal((await c.post("/api/users", { username: "kept", role: "viewer" })).status, 201);
  pointsBefore = await points();

  const r = cli("backup", "--json");
  assert.equal(r.code, 0, r.err);
  first = JSON.parse(r.out);
  assert.equal(path.dirname(first.path), backups);
  assert.equal(mode(backups), 0o700);

  const m = JSON.parse(fs.readFileSync(path.join(first.path, "manifest.json"), "utf8"));
  assert.equal(m.app_version, VERSION);
  assert.equal(m.reason, "manual");
  assert.ok(m.schema >= 9, `schema ${m.schema}`);
  const files = Object.fromEntries(m.files.map((f) => [f.path, f]));
  for (const f of ["data/paddock.db", "data/auth.json", "config/config.yaml", "config/llama-paddock.env"]) assert.ok(files[f], `${f} in ${Object.keys(files)}`);
  assert.equal(files["config/config.yaml"].role, "config");
  assert.equal(files["config/llama-paddock.env"].role, "env");
  for (const f of m.files) assert.equal(mode(path.join(first.path, f.path)), 0o600, f.path);
  // the database is snapshotted, never copied with its WAL; the lock and the backups themselves stay out
  assert.ok(!Object.keys(files).some((f) => /paddock\.db-|paddock\.lock|backups\//.test(f)), Object.keys(files).join(" "));
  assert.equal(cli("verify", first.name).code, 0);

  const list = JSON.parse(cli("list", "--json").out);
  assert.deepEqual(list.map((b) => b.name), [first.name]);
});

test("restore refuses while the dashboard runs, and changes nothing", async () => {
  const r = cli("restore", first.name);
  assert.equal(r.code, 2);
  assert.match(r.err, /dashboard is running \(pid \d+\)/);
  assert.equal(fs.readdirSync(backups).length, 1, "no pre-restore backup either");
});

test("restore refuses a damaged backup and one from a newer version", async () => {
  const damaged = path.join(backups, "damaged");
  fs.cpSync(first.path, damaged, { recursive: true });
  fs.appendFileSync(path.join(damaged, "data/auth.json"), " ");
  assert.equal(cli("verify", "damaged").code, 1);
  let r = cli("restore", "damaged");
  assert.equal(r.code, 2);
  assert.match(r.err, /damaged, nothing was changed[\s\S]*data\/auth\.json: checksum/);
  fs.rmSync(damaged, { recursive: true });

  const newer = path.join(backups, "newer");
  fs.cpSync(first.path, newer, { recursive: true });
  const mf = path.join(newer, "manifest.json");
  fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, "utf8")), app_version: "99.0.0" }));
  r = cli("restore", "newer");
  assert.equal(r.code, 2);
  assert.match(r.err, /newer than this install .*Install v99\.0\.0 first/);
  fs.rmSync(newer, { recursive: true });
});

test("restore puts the install back as it was, and keeps what it replaced", async () => {
  // changes after the backup, which the restore must undo
  assert.equal((await c.post("/api/users", { username: "later", role: "viewer" })).status, 201);
  const config = fs.readFileSync(stack.data.config, "utf8");
  fs.appendFileSync(stack.data.config, "# edited after the backup\n");
  fs.writeFileSync(envFile, "PADDOCK_USERNAME=someone-else\n");
  fs.writeFileSync(path.join(stack.data.data, "added-later.json"), "{}");

  await stack.dashboard.stop();
  const r = cli("restore", first.name, "--json");
  assert.equal(r.code, 0, r.err);
  const res = JSON.parse(r.out);
  assert.match(res.before.name, /-pre-restore$/);
  assert.equal(res.before.warning, null);
  assert.equal(cli("verify", res.before.name).code, 0);

  assert.equal(fs.readFileSync(stack.data.config, "utf8"), config);
  assert.equal(fs.readFileSync(envFile, "utf8"), "PADDOCK_USERNAME=admin\n");
  assert.ok(!fs.existsSync(path.join(stack.data.data, "added-later.json")));
  assert.equal(mode(path.join(stack.data.data, "auth.json")), 0o600);

  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  // the session key is in the restored auth data, so the old session still works
  const c2 = new Client(stack.dashboard.url);
  c2.cookie = c.cookie;
  c = c2;
  assert.deepEqual(await users(), ["admin", "kept"]);
  assert.ok((await points()) >= pointsBefore, "history from before the backup is back");
});

test("restore --data-only leaves config.yaml alone", async () => {
  fs.appendFileSync(stack.data.config, "# kept\n");
  await stack.dashboard.stop();
  const r = cli("restore", first.name, "--data-only");
  assert.equal(r.code, 0, r.err);
  assert.match(fs.readFileSync(stack.data.config, "utf8"), /# kept\n$/);
});

test("restore never writes through a link in the data directory, and changes nothing", () => {
  // run as root by the installer's updater, it writes into a directory the dashboard's user can change
  const sub = path.join(stack.data.data, "linked");
  fs.mkdirSync(sub, { mode: 0o700 });
  fs.writeFileSync(path.join(sub, "x.json"), "{}", { mode: 0o600 });
  const b = JSON.parse(cli("backup", "--json").out);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-outside-"));
  fs.rmSync(sub, { recursive: true });
  fs.symlinkSync(outside, sub);
  const db = fs.readFileSync(path.join(stack.data.data, "paddock.db"));
  try {
    const r = cli("restore", b.name);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /leads outside/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(db.equals(fs.readFileSync(path.join(stack.data.data, "paddock.db"))), "the database was left alone");
  } finally {
    fs.rmSync(sub);
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(path.join(backups, b.name), { recursive: true, force: true });
  }
});

test("restore replaces a damaged database, and keeps its files as they were", async () => {
  const db = path.join(stack.data.data, "paddock.db");
  fs.writeFileSync(db, "not a database");
  const r = cli("restore", first.name, "--json");
  assert.equal(r.code, 0, r.err);
  const { before } = JSON.parse(r.out);
  assert.match(before.warning, /couldn't be read/);
  assert.equal(fs.readFileSync(path.join(backups, before.name, "data/paddock.db"), "utf8"), "not a database");

  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  const c2 = new Client(stack.dashboard.url);
  c2.cookie = c.cookie;
  c = c2;
  assert.ok((await points()) >= pointsBefore, "the restored history is readable");
});

test("automatic backups are pruned to the newest few; manual ones are kept", async () => {
  for (let i = 0; i < 6; i++) assert.equal(cli("backup", "--reason", "pre-update").code, 0);
  const list = JSON.parse(cli("list", "--json").out);
  assert.equal(list.filter((b) => b.reason === "pre-update").length, 5);
  assert.ok(list.some((b) => b.name === first.name), "the manual backup is still there");
});
