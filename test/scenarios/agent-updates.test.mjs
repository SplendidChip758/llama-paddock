// Agent updates (#15): the dashboard compares each agent with the newest agent release on its
// channel, flags older ones, and updates them through the agent's POST /update. A failed update
// keeps the old agent and shows the updater's output; agents too old to update themselves are
// flagged with what to run on the host instead. GitHub is the simulator's /_sim/github.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { Client, scenarioTest, startStack } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, current;

before(async () => {
  // dev: the channel doesn't then depend on whether this dashboard's own version is a prerelease
  holder.stack = await startStack({ sim: { hosts: 3 }, data: { extra: "agent_updates: dev" } });
  ({ client: c, sim } = holder.stack);
  for (const id of ["sim-1", "sim-2", "sim-3"]) {
    // whether or not the agent in test/agent-release can update itself, which sets the simulator's default
    await sim.scenario(id, { agent_update: "normal" });
    await c.waitInstance(id, (x) => x.ollama_ok && x.agent_ok && x.agent_update?.can_update, "online and able to update");
  }
  current = (await c.instance("sim-1")).agent_version;
});
after(() => holder.stack?.stop());

async function publish(linux, windows) {
  const r = await fetch(`${sim.control}/github/releases`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linux, windows }),
  });
  assert.equal(r.status, 200, await r.text());
  const rel = await c.get("/api/agent-releases?refresh=1");
  assert.equal(rel.status, 200, JSON.stringify(rel.data));
  return rel.data;
}

test("agents on the newest release aren't flagged", async () => {
  const rel = (await c.get("/api/agent-releases")).data;
  assert.equal(rel.channel, "dev");
  const i = await c.waitInstance("sim-1", (x) => x.agent_update?.latest === current, "the latest release to be known");
  assert.equal(i.agent_update.platform, "linux");
  assert.equal(i.agent_update.outdated, false);
  assert.equal(i.agent_update.can_update, true);
  assert.equal(i.agent_update.run, null);
});

test("an older agent is flagged and updated from the dashboard", async () => {
  // Windows agent releases ship llama-paddock-agent-setup.exe (before it, the Node.js agent's zip)
  const rel = await publish([`v${current}`, "v9.0.0-dev.1", "v8.0.0"], ["v0.10.0", "v0.11.0-dev.1"]);
  assert.equal(rel.platforms.linux.latest, "9.0.0-dev.1");
  assert.equal(rel.platforms.linux.error, null);
  assert.equal(rel.platforms.windows.latest, "0.11.0-dev.1", JSON.stringify(rel.platforms.windows));
  await c.waitInstance("sim-1", (x) => x.agent_update?.outdated && x.agent_update.latest === "9.0.0-dev.1", "the agent to be flagged");

  const r = await c.post("/api/instances/sim-1/agent-update");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state, "running");
  assert.equal(r.data.from, current);
  // a second click while it runs
  assert.equal((await c.post("/api/instances/sim-1/agent-update")).status, 409);

  const done = await c.waitInstance("sim-1", (x) => x.agent_update?.run?.state === "done", "the update to finish");
  assert.equal(done.agent_version, "9.0.0-dev.1");
  assert.equal(done.agent_update.run.to, "9.0.0-dev.1");
  assert.equal(done.agent_update.outdated, false);
  assert.equal((await sim.state("sim-1")).agent_version, "9.0.0-dev.1");

  const audit = (await c.get("/api/audit?action=host.agent_update")).data.entries;
  assert.ok(audit.some((e) => e.instance === "sim-1" && e.detail.includes(current)), JSON.stringify(audit));
});

test("updating an agent that is already current says so", async () => {
  assert.equal((await c.post("/api/instances/sim-1/agent-update")).status, 200);
  const i = await c.waitInstance("sim-1", (x) => x.agent_update?.run?.state === "done", "the update to finish");
  assert.match(i.agent_update.run.detail, /already on the newest release/);
  assert.equal(i.agent_version, "9.0.0-dev.1");
});

test("a failed update keeps the old agent and shows the updater's output", async () => {
  await sim.scenario("sim-2", { agent_update: "fail" });
  assert.equal((await c.post("/api/instances/sim-2/agent-update")).status, 200);
  const i = await c.waitInstance("sim-2", (x) => x.agent_update?.run?.state === "failed", "the update to fail");
  assert.equal(i.agent_version, current);
  assert.match(i.agent_update.run.detail, /updater failed/);
  assert.ok(i.agent_update.run.log.some((l) => /SHA256SUMS/.test(l)), JSON.stringify(i.agent_update.run.log));
  assert.equal(i.agent_update.outdated, true);
  await sim.scenario("sim-2", { agent_update: "normal" });
});

test("an agent that can't update itself gets the command to run on the host", async () => {
  await sim.scenario("sim-3", { agent_update: "none" });
  const i = await c.waitInstance("sim-3", (x) => x.agent_update?.outdated && !x.agent_update.can_update, "the agent to need a manual update");
  assert.match(i.agent_update.manual_reason, /update-llama-paddock-agent/);
  const r = await c.post("/api/instances/sim-3/agent-update");
  assert.equal(r.status, 409);
  assert.match(r.data.detail, /update-llama-paddock-agent/);
});

test("Update all starts every agent the dashboard can update and lists the rest", async () => {
  const r = await c.post("/api/agent-updates");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.started, ["sim-2"]);
  assert.deepEqual(r.data.skipped.map((s) => s.id), ["sim-3"]);
  assert.deepEqual(r.data.failed, []);
  await c.waitInstance("sim-2", (x) => x.agent_update?.run?.state === "done" && x.agent_version === "9.0.0-dev.1", "sim-2 to be updated");
});

test("the release check is cached, not repeated on every poll", async () => {
  const reads = async () => (await fetch(`${sim.control}/github/requests`).then((r) => r.json())).reads;
  const before = await reads();
  // several polls
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await reads(), before);
  // and a refresh at most once a minute
  await c.get("/api/agent-releases?refresh=1");
  const once = await reads();
  await c.get("/api/agent-releases?refresh=1");
  assert.equal(await reads(), once);
});

test("viewers see agent updates but can't start them", async () => {
  const u = await c.post("/api/users", { username: "update-viewer", role: "viewer" });
  assert.equal(u.status, 201, JSON.stringify(u.data));
  const v = new Client(holder.stack.dashboard.url);
  const login = await v.post("/api/auth/login", { username: "update-viewer", password: u.data.password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal((await v.post("/api/auth/password", { password: "viewer-password-1" })).status, 200);
  assert.equal((await v.get("/api/agent-releases")).status, 200);
  assert.equal((await v.post("/api/instances/sim-1/agent-update")).status, 403);
  assert.equal((await v.post("/api/agent-updates")).status, 403);
});
