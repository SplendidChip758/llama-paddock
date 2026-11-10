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
    message: `v${LATEST} didn't answer on /api/healthz within 2 minutes`, backup: "20261109T000000Z-pre-update",
  }));
  fs.writeFileSync(path.join(updater, "update.log"), " \x1b[33m!\x1b[0m Rolling back\n \x1b[32m✔\x1b[0m Rolled back\n");
  const u = (await c.get("/api/dashboard-update")).data;
  assert.equal(u.run.state, "rolled_back");
  assert.equal(u.run.backup, "20261109T000000Z-pre-update");
  assert.match(u.run.message, /healthz/);
  assert.deepEqual(u.run.log, [" ! Rolling back", " ✔ Rolled back"]);
  // it isn't under way any more, so it can be tried again
  const again = await c.post("/api/dashboard-update", { version: LATEST });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  fs.rmSync(request);
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
