// Dashboard restart recovery: stop the dashboard mid-pull and start it again on the same data
// directory. Metric history from before the restart is still there, the session still works, the
// running pull resumes (Ollama sees a second /api/pull) and finishes, and a job that can't resume
// is marked interrupted instead of hanging as "running" forever.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { Client, scenarioTest, startDashboard, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;
const MODEL = "llama3.1:8b";
let pullJob, createJob, firstPointBefore, pointsBefore;

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 1, pullSeconds: 3 } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

const history = async (client) => {
  const r = await client.get("/api/instances/sim-1/history");
  assert.equal(r.status, 200);
  return r.data.points;
};

test("before the restart: history is recorded and a pull and a create are running", async () => {
  await waitFor(async () => (await history(c)).length >= 3, { what: "a few history points" });

  pullJob = (await c.post("/api/instances/sim-1/models/pull", { model: MODEL })).data;
  await c.waitJob(pullJob.id, (j) => j.completed > 0, "progress");
  // hold the download, so it is still running when the dashboard goes down
  await sim.scenario("sim-1", { pull: "stall", create: "stall" });

  const r = await c.post("/api/instances/sim-1/models/create", { model: "llama-big:latest", from: "llama3.2:3b", parameters: { num_ctx: 32768 } });
  assert.equal(r.status, 200);
  createJob = r.data;
  await c.waitJob(createJob.id, (j) => j.status.startsWith("using existing layer"), "create started");

  const points = await history(c);
  firstPointBefore = points[0].t;
  pointsBefore = points.length;
});

test("stopping the dashboard cuts the pull off on the Ollama side", async () => {
  const { code, signal } = await stack.dashboard.stop();
  // Next.js exits with 128 + SIGTERM after shutting down cleanly
  assert.ok([0, 143].includes(code) || signal === "SIGTERM", `dashboard exit: ${code} ${signal}`);
  await waitFor(async () => (await sim.state("sim-1")).pulls.at(-1).outcome === "aborted", { what: "the sim to see the pull end" });
});

test("after the restart: same session, same history, the pull resumes and finishes", async () => {
  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  // the session cookie is signed with a key in the data dir, so it survives the restart
  const c2 = new Client(stack.dashboard.url);
  c2.cookie = c.cookie;
  assert.equal((await c2.get("/api/auth/me")).data.username, "admin");
  c = c2;

  const resumed = await c.job(pullJob.id);
  assert.ok(resumed, "the pull job is still listed");
  assert.equal(resumed.state, "running");
  const pulls = await waitFor(async () => {
    const p = (await sim.state("sim-1")).pulls.filter((x) => x.model === MODEL);
    return p.length === 2 && p;
  }, { what: "a second /api/pull for the model" });
  assert.ok(pulls[1].resumed_from > 0, "Ollama resumed from the partial download");

  await sim.scenario("sim-1", { pull: "normal", create: "normal" });
  const done = await c.waitJob(pullJob.id, (j) => j.state !== "running", "finished");
  assert.equal(done.state, "done");
  const models = await c.get("/api/instances/sim-1/models");
  assert.ok(models.data.models.some((m) => m.name === MODEL));

  // the history from before the restart is still there, and polling carries on
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online again");
  const points = await waitFor(async () => {
    const p = await history(c);
    return p.length > pointsBefore && p;
  }, { what: "new history points" });
  assert.equal(points[0].t, firstPointBefore, "the first history point is unchanged");
});

test("after the restart: a create that can't resume is marked interrupted", async () => {
  const j = await c.job(createJob.id);
  assert.equal(j.state, "error");
  assert.match(j.error, /interrupted: the dashboard restarted/);
  assert.ok(j.finished);
});
