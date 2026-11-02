// Alert history, silences and uptime (#9): silences and acknowledgements mark alerts without
// changing them, acknowledgements end when their alert resolves, both survive a restart; uptime
// shows outages with their errors, and time the dashboard wasn't polling is unobserved, not downtime.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { Client, scenarioTest, startDashboard, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

const RULES = [
  { id: "hot", name: "GPU hot", kind: "gpu_temp", threshold: 80, for_s: 0, clear_s: 1 },
];

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,1" } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
  await c.waitInstance("sim-2", (x) => x.ollama_ok && x.agent_ok, "online");
  assert.equal((await c.put("/api/alerts/rules", { rules: RULES })).status, 200);
});
after(() => holder.stack?.stop());

const active = async () => (await c.get("/api/alerts")).data.active;
const alertOn = async (instance) => (await active()).find((a) => a.rule === "hot" && a.instance === instance);
const waitAlert = (instance, pred, what) => {
  let seen;
  return waitFor(async () => {
    seen = await alertOn(instance);
    return seen && pred(seen) && seen;
  }, { what: `${instance}: ${what}`, describe: () => seen });
};
const silences = async () => (await c.get("/api/alerts/silences")).data.silences;
const uptime = async (id, range = "24h") => {
  const r = await c.get(`/api/instances/${id}/uptime?range=${range}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

test("silences are checked: they need a host or a rule, a sane duration, and an active alert to acknowledge", async () => {
  const cases = [
    [{ duration_s: 3600 }, 400, /needs a host, a rule, or both/],
    [{ instance: "nope", duration_s: 3600 }, 400, /unknown host nope/],
    [{ rule: "nope", duration_s: 3600 }, 400, /unknown rule nope/],
    [{ instance: "sim-1", duration_s: 5 }, 400, /duration_s must be/],
    [{ instance: "sim-1", until_resolved: true }, 400, /names one alert/],
    [{ rule: "hot", instance: "sim-1", subject: "gpu0", until_resolved: true }, 409, /isn't active/],
  ];
  for (const [body, status, re] of cases) {
    const r = await c.post("/api/alerts/silences", body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.data.detail, re);
  }
  assert.deepEqual(await silences(), []);
});

test("a host silence marks that host's alerts until it is removed", async () => {
  await sim.scenario("sim-1", { gpu_temp: 90 });
  await sim.scenario("sim-2", { gpu_temp: 90 });
  await waitAlert("sim-1", (a) => a.state === "firing", "firing");
  await waitAlert("sim-2", (a) => a.state === "firing", "firing");

  const r = await c.post("/api/alerts/silences", { instance: "sim-1", duration_s: 3600, note: "maintenance" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = r.data.silence;
  assert.equal(s.rule, null);
  assert.ok(Math.abs(s.until - (s.created + 3600)) < 1);

  const one = await alertOn("sim-1");
  assert.equal(one.silence?.id, s.id, "sim-1's alert is silenced");
  assert.equal(one.state, "firing", "a silence doesn't change the alert");
  assert.equal((await alertOn("sim-2")).silence, null, "sim-2 isn't");

  assert.equal((await c.del(`/api/alerts/silences/${s.id}`)).status, 200);
  assert.equal((await alertOn("sim-1")).silence, null);
  assert.equal((await c.del(`/api/alerts/silences/${s.id}`)).status, 404);
});

test("an acknowledgement lasts until its alert resolves", async () => {
  const r = await c.post("/api/alerts/silences", { rule: "hot", instance: "sim-2", subject: "gpu0", until_resolved: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.silence.until, null);
  assert.equal((await alertOn("sim-2")).silence?.until_resolved, true);

  await sim.scenario("sim-2", { gpu_temp: null });
  await waitFor(async () => !(await alertOn("sim-2")), { what: "sim-2's alert to resolve" });
  assert.deepEqual((await silences()).map((x) => x.id).includes(r.data.silence.id), false, "the acknowledgement ended with the alert");
});

test("an Ollama outage shows on the timeline with its error; the agent's stays up", async () => {
  await sim.scenario("sim-2", { ollama: "down" });
  await c.waitInstance("sim-2", (x) => !x.ollama_ok, "Ollama down");
  await new Promise((r) => setTimeout(r, 3000));
  await sim.scenario("sim-2", { ollama: "up" });
  await c.waitInstance("sim-2", (x) => x.ollama_ok, "Ollama back");

  const u = await waitFor(async () => {
    const x = await uptime("sim-2");
    return x.ollama.outages.length && !x.ollama.outages[0].ongoing && x;
  }, { what: "the outage to end on the timeline" });
  const [o] = u.ollama.outages;
  assert.match(o.error, /ECONNREFUSED/);
  assert.ok(o.end - o.start >= 2 && o.end - o.start < 30, `outage length ${o.end - o.start}`);
  assert.ok(u.ollama.up_pct < 100 && u.ollama.up_pct > 0, `up_pct ${u.ollama.up_pct}`);
  assert.equal(u.agent.outages.length, 0);
  assert.equal(u.agent.up_pct, 100);
  // the dashboard has only watched for a minute of the 24 hours: the rest is unobserved, not down
  assert.ok(u.coverage < 0.05);
  assert.ok(u.ollama.unobserved_s > 80_000);
  assert.equal(u.ollama.segments[0].state, "unobserved");
  assert.deepEqual(u.ollama.segments.filter((x) => x.state !== "unobserved").map((x) => x.state).slice(-3), ["up", "down", "up"]);

  const sum = await c.get("/api/uptime?range=24h");
  assert.equal(sum.status, 200);
  assert.equal(sum.data.hosts["sim-2"].ollama.outages, 1);
  assert.equal(sum.data.hosts["sim-1"].ollama.outages, 0);
  assert.equal("segments" in sum.data.hosts["sim-2"].ollama, false, "the summary leaves the timelines out");
  assert.equal((await c.get("/api/instances/sim-2/uptime?range=2y")).status, 400);
});

test("after a restart, silences are kept and the gap is unobserved", async () => {
  const s = (await c.post("/api/alerts/silences", { instance: "sim-1", duration_s: 3600 })).data.silence;
  await stack.dashboard.stop();
  await new Promise((r) => setTimeout(r, 2500));
  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  const c2 = new Client(stack.dashboard.url);
  c2.cookie = c.cookie;
  c = c2;

  assert.deepEqual((await silences()).map((x) => x.id), [s.id]);
  await waitAlert("sim-1", (a) => !a.unknown, "seen again after the restart");
  assert.equal((await alertOn("sim-1")).silence?.id, s.id);

  const u = await waitFor(async () => {
    const x = await uptime("sim-1");
    // leave out the sliver since the last poll; before it: up, the restart's unobserved gap, up again
    const segs = x.ollama.segments;
    const seen = segs.at(-1).state === "unobserved" ? segs.slice(0, -1) : segs;
    return seen.slice(-3).map((y) => y.state).join() === "up,unobserved,up" && { ...x, gap: seen.at(-2) };
  }, { what: "a gap on the timeline" });
  const { gap } = u;
  assert.ok(gap.end - gap.start >= 2, `gap ${gap.end - gap.start}`);
  assert.equal(u.ollama.outages.length, 0, "the restart isn't an outage");
  await sim.scenario("sim-1", { gpu_temp: null });
});

test("silenced alerts aren't sent to notification channels; an acknowledged one still reports resolving", async (t) => {
  // runs once notification channels (#8) are in the build
  if ((await c.get("/api/alerts/channels")).status === 404) return t.skip("needs notification channels (#8)");
  const hook = `${sim.control}/webhook/silenced`;
  const received = async () => (await (await fetch(hook)).json()).received.map((m) => `${m.body.state}:${m.body.alert?.instance}`);
  assert.equal((await c.put("/api/alerts/channels", { channels: [{ id: "hook", type: "webhook", url: hook }] })).status, 200);
  assert.equal((await c.put("/api/alerts/rules", { rules: [{ ...RULES[0], id: "hot-quiet", hosts: ["sim-2"] }] })).status, 200);
  const transitions = async () => (await c.get("/api/alerts/transitions?limit=1000")).data.transitions.filter((x) => x.rule === "hot-quiet");
  const waitTransitions = (n, what) => waitFor(async () => (await transitions()).length >= n, { what });

  // silenced while it fires: neither the firing nor, later, the resolving is sent
  const s = (await c.post("/api/alerts/silences", { instance: "sim-2", duration_s: 3600 })).data.silence;
  await sim.scenario("sim-2", { gpu_temp: 90 });
  await waitTransitions(1, "hot-quiet to fire");
  assert.equal((await c.del(`/api/alerts/silences/${s.id}`)).status, 200);
  await sim.scenario("sim-2", { gpu_temp: null });
  await waitTransitions(2, "hot-quiet to resolve");
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(await received(), [], "nothing sent for a silenced alert");

  // fires unsilenced, then acknowledged: both its firing and its resolving are sent
  await sim.scenario("sim-2", { gpu_temp: 91 });
  await waitFor(async () => (await received()).length === 1, { what: "the firing message" });
  await waitFor(async () => (await c.get("/api/alerts")).data.active.some((a) => a.rule === "hot-quiet"), { what: "the alert to be active" });
  assert.equal((await c.post("/api/alerts/silences", { rule: "hot-quiet", instance: "sim-2", subject: "gpu0", until_resolved: true })).status, 201);
  await sim.scenario("sim-2", { gpu_temp: null });
  await waitFor(async () => (await received()).length === 2, { what: "the resolved message" });
  assert.deepEqual(await received(), ["firing:sim-2", "resolved:sim-2"]);
  await c.put("/api/alerts/channels", { channels: [] });
});
