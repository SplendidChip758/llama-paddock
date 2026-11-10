// Dashboard updates (#48): the dashboard looks for a newer release of itself on its own channel and
// shows its notes. On an installer install it asks the root updater for it by writing a request into
// the data directory, and shows what the updater reports in PADDOCK_UPDATER_DIR. Docker and other
// installs are told how to update instead. GitHub is the simulator's /_sim/github; the updater itself
// is install/dashboard.sh, so here the test plays its part.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO, scenarioTest, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "dashboard/package.json"), "utf8")).version;
const DEV = VERSION.includes("-");
// newer releases this dashboard offers, newest first: a prerelease dashboard follows stable releases
// too, a stable one never offers a prerelease
const NEWER = DEV ? ["v99.0.0-dev.2", "v99.0.0-dev.1", "v98.0.0"] : ["v99.1.0", "v99.0.0"];
const OTHER = DEV ? [] : ["v100.0.0-dev.1"];
const LATEST = NEWER[0].slice(1);

let c, sim, updater, request;

before(async () => {
  updater = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-updater-"));
  holder.stack = await startStack({
    sim: { hosts: 1 },
    env: { PADDOCK_INSTALL_METHOD: "installer", PADDOCK_UPDATER_DIR: updater },
  });
  ({ client: c, sim } = holder.stack);
  request = path.join(holder.stack.data.data, "update-request.json");
});
after(async () => {
  await holder.stack?.stop();
  fs.rmSync(updater, { recursive: true, force: true });
});

async function publish(dashboard) {
  const r = await fetch(`${sim.control}/github/releases`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboard }),
  });
  assert.equal(r.status, 200, await r.text());
}

test("without a newer release nothing is offered", async () => {
  await publish([`v${VERSION}`]);
  // the first look asks GitHub in the background
  const u = await waitFor(async () => {
    const r = (await c.get("/api/dashboard-update")).data;
    return r.checked && r;
  }, { what: "the release check" });
  assert.equal(u.current, VERSION);
  assert.equal(u.channel, DEV ? "dev" : "stable");
  assert.equal(u.check, true);
  assert.equal(u.error, null);
  assert.ok(u.checked);
  assert.equal(u.available, false);
  assert.deepEqual(u.releases, []);
  assert.equal(u.method, "installer");
  assert.equal(u.can_update, true);
  assert.equal(u.run, null);
});

test("newer releases on the install's channel are offered with their notes, newest first", async () => {
  await publish(["v0.0.1", ...NEWER.slice(1), ...OTHER, NEWER[0]]);
  // Check now; the answer is otherwise cached for hours
  const u = (await c.get("/api/dashboard-update?refresh=1")).data;
  assert.equal(u.available, true);
  assert.equal(u.latest, LATEST);
  assert.deepEqual(u.releases.map((r) => r.version), NEWER.map((t) => t.slice(1)));
  assert.match(u.releases[0].notes, new RegExp(`notes for ${NEWER[0]}`));
  assert.match(u.releases[0].url, /^https:\/\/github\.com\//);
});

test("an admin's update request goes to the updater, once, for the newest release only", async () => {
  const stale = await c.post("/api/dashboard-update", { version: NEWER[1] });
  assert.equal(stale.status, 409);
  assert.match(stale.data.detail, new RegExp(LATEST.replace(/\./g, "\\.")));
  assert.equal(fs.existsSync(request), false);

  const r = await c.post("/api/dashboard-update", { version: LATEST });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.run.state, "requested");
  assert.equal(r.data.run.version, LATEST);
  assert.equal(r.data.run.from, VERSION);

  // the updater runs as root and reads only the version from it
  const req = JSON.parse(fs.readFileSync(request, "utf8"));
  assert.equal(req.version, `v${LATEST}`);
  assert.equal(fs.statSync(request).mode & 0o777, 0o600);

  assert.equal((await c.post("/api/dashboard-update", { version: LATEST })).status, 409);

  const audit = (await c.get("/api/audit?action=dashboard.update")).data.entries[0];
  assert.equal(audit.target, LATEST);
  assert.equal(audit.detail, `from ${VERSION}`);
});

test("a pending request isn't in a backup, so a restore can't start the update again", () => {
  const env = { ...process.env, PADDOCK_DATA_DIR: holder.stack.data.data, PADDOCK_CONFIG: holder.stack.data.config };
  const r = spawnSync(process.execPath, [path.join(REPO, "dashboard/bin/paddock-backup.mjs"), "backup", "--json"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(JSON.parse(r.stdout).path, "manifest.json"), "utf8"));
  assert.ok(manifest.files.length > 0);
  assert.ok(!manifest.files.some((f) => f.path.endsWith("update-request.json")));
});

test("what the updater reports is shown, with its output", async () => {
  // as llama-paddock-updater does: take the request, report, then the outcome
  fs.rmSync(request);
  const now = Date.now() / 1000;
  fs.writeFileSync(path.join(updater, "status.json"), JSON.stringify({
    state: "rolled_back", version: LATEST, from: VERSION, started: now - 60, finished: now,
    message: `v${LATEST} didn't answer on /api/healthz within 2 minutes`, backup: "20261109T000000Z-v0.10.0-pre-update",
  }));
  fs.writeFileSync(path.join(updater, "update.log"), " \x1b[33m!\x1b[0m Rolling back\n \x1b[32m✔\x1b[0m Rolled back\n");
  const u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.run.state, "rolled_back");
  assert.equal(u.run.backup, "20261109T000000Z-v0.10.0-pre-update");
  assert.match(u.run.message, /healthz/);
  assert.deepEqual(u.run.log, [" ! Rolling back", " ✔ Rolled back"]);
  // the updater from 0.10.0 only updated, and named nobody
  assert.equal(u.run.action, "update");
  assert.equal(u.run.by, null);
  // it isn't under way any more, so it can be tried again
  const again = await c.post("/api/dashboard-update", { version: LATEST });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  fs.rmSync(request);
});

// ============================================================================ history, rollback, channel, automatic updates
/** A pre-update backup taken by an older version, as the updater keeps it in the data directory. */
function olderBackup(older) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-oldapp-"));
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ version: older }));
  const env = { ...process.env, PADDOCK_DATA_DIR: holder.stack.data.data, PADDOCK_CONFIG: holder.stack.data.config, PADDOCK_APP_DIR: app };
  const r = spawnSync(process.execPath, [path.join(REPO, "dashboard/bin/paddock-backup.mjs"), "backup", "--reason", "pre-update", "--json"], { env, encoding: "utf8" });
  fs.rmSync(app, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).name;
}

const history = (entries) =>
  fs.writeFileSync(path.join(updater, "history.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

test("the history lists finished runs newest first; an update can be rolled back while its backup is kept", async () => {
  const kept = olderBackup("0.0.2");
  const now = Date.now() / 1000;
  history([
    { state: "done", action: "update", version: "0.0.2", from: "0.0.1", started: now - 900, finished: now - 860, backup: "20200101T000000Z-v0.0.1-pre-update", by: "terminal" },
    { state: "rolled_back", action: "automatic", version: "9.9.9", from: "0.0.2", started: now - 600, finished: now - 560, message: "it didn't answer", backup: null, by: "automatic" },
    { state: "done", action: "update", version: VERSION, from: "0.0.2", started: now - 300, finished: now - 260, backup: kept, by: "admin" },
    "not json",
  ]);
  const u = (await c.get("/api/dashboard-update")).data;
  assert.deepEqual(u.history.map((h) => [h.action, h.state, h.by, h.can_roll_back]), [
    ["update", "done", "admin", true],
    ["automatic", "rolled_back", "automatic", false],
    // its backup is gone
    ["update", "done", "terminal", false],
  ]);

  assert.equal((await c.post("/api/dashboard-update", { action: "rollback", backup: "20200101T000000Z-v0.0.1-pre-update" })).status, 409);
  const r = await c.post("/api/dashboard-update", { action: "rollback", backup: kept });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.run.state, "requested");
  assert.equal(r.data.run.action, "rollback");
  const req = JSON.parse(fs.readFileSync(request, "utf8"));
  assert.deepEqual([req.action, req.version, req.backup, req.requested_by], ["rollback", "v0.0.2", kept, "admin"]);
  const audit = (await c.get("/api/audit?action=dashboard.rollback")).data.entries[0];
  assert.equal(audit.target, "0.0.2");
  fs.rmSync(request);
});

test("a channel switch goes to the updater; the channel shown is the updater's", async () => {
  fs.writeFileSync(path.join(updater, "channel"), "latest\n");
  let u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.channel, "stable");
  assert.equal((await c.post("/api/dashboard-update", { action: "channel", channel: "stable" })).status, 409);
  assert.equal((await c.post("/api/dashboard-update", { action: "channel", channel: "nightly" })).status, 400);

  const r = await c.post("/api/dashboard-update", { action: "channel", channel: "dev" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.run.action, "channel");
  assert.equal(JSON.parse(fs.readFileSync(request, "utf8")).channel, "dev");
  fs.rmSync(request);

  // as the updater writes it after the switch
  fs.writeFileSync(path.join(updater, "channel"), "dev\n");
  u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.channel, "dev");
});

test("automatic updates are turned on and off through the updater, and only on the stable channel", async () => {
  // still on prereleases from the test above
  let r = await c.post("/api/dashboard-update", { action: "auto", enabled: true });
  assert.equal(r.status, 409);
  assert.match(r.data.detail, /stable/);

  fs.writeFileSync(path.join(updater, "channel"), "latest\n");
  let u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.auto_update, false);
  r = await c.post("/api/dashboard-update", { action: "auto", enabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // shown as on before the updater has written it, and not as an update under way
  assert.equal(r.data.auto_update, true);
  assert.notEqual(r.data.run?.state, "requested");
  assert.equal(JSON.parse(fs.readFileSync(request, "utf8")).enabled, true);
  // one request at a time
  assert.equal((await c.post("/api/dashboard-update", { action: "auto", enabled: false })).status, 409);

  // as the updater does
  fs.rmSync(request);
  fs.writeFileSync(path.join(updater, "auto-update"), "on\n");
  u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.auto_update, true);
  assert.equal((await c.get("/api/audit?action=dashboard.auto_update")).data.entries[0].detail, "on");
});

test("without the updater, the dashboard says to run update-llama-paddock", async () => {
  fs.rmSync(updater, { recursive: true, force: true });
  let u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.method, "installer");
  assert.equal(u.can_update, false);
  let r = await c.post("/api/dashboard-update", { version: LATEST });
  assert.equal(r.status, 409);
  assert.match(r.data.detail, /update-llama-paddock/);
  assert.equal(fs.existsSync(request), false);
  fs.mkdirSync(updater);
  u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.can_update, true);
});

test("in Docker the image is updated by hand; update_check: false never asks GitHub", async () => {
  const docker = await startStack({ sim: { hosts: 1 }, data: { extra: "update_check: false" }, env: { PADDOCK_INSTALL_METHOD: "docker" } });
  try {
    await fetch(`${docker.sim.control}/github/releases`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboard: NEWER }),
    });
    const u = (await docker.client.get("/api/dashboard-update?refresh=1")).data;
    assert.equal(u.method, "docker");
    assert.equal(u.can_update, false);
    assert.equal(u.check, false);
    assert.equal(u.available, false);
    assert.equal(u.checked, null);
    const r = await docker.client.post("/api/dashboard-update", { version: LATEST });
    assert.equal(r.status, 409);
    assert.match(r.data.detail, /docker compose pull/);
  } finally {
    await docker.stop();
  }
});
