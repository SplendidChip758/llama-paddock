// Alert rules: a threshold has to hold for the rule's duration before it fires and stay clear
// before it resolves; rules apply to every host or to chosen ones; flapping alerts are held back;
// unreachable hosts and Ollama crashes fire; and missing observations (agent down, a dashboard
// restart) neither fire nor resolve anything.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client, scenarioTest, startDashboard, startStack, waitFor } from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
let c, sim, stack;

const RULES = [
  { id: "hot", name: "GPU hot", kind: "gpu_temp", threshold: 80, for_s: 3, clear_s: 2, hosts: ["sim-1"] },
  { id: "flappy", name: "GPU hot (sim-2)", kind: "gpu_temp", threshold: 80, for_s: 0, clear_s: 1, hosts: ["sim-2"] },
  { id: "disk", name: "Disk nearly full", kind: "disk", threshold: 90, for_s: 2, clear_s: 1 },
  { id: "down", name: "Host down", kind: "host_unreachable", for_s: 2, clear_s: 1 },
  { id: "crash", name: "Ollama crashed", kind: "ollama_crash", for_s: 2, clear_s: 1 },
];

before(async () => {
  stack = holder.stack = await startStack({ sim: { hosts: 2, gpus: "1,1" } });
  ({ client: c, sim } = stack);
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
  await c.waitInstance("sim-2", (x) => x.ollama_ok && x.agent_ok, "online");
});
after(() => holder.stack?.stop());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

const active = async () => {
  const r = await c.get("/api/alerts");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.active;
};
const transitions = async () => {
  const r = await c.get("/api/alerts/transitions?limit=1000");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.transitions;
};
const of = (list, rule, instance) => list.filter((x) => x.rule === rule && x.instance === instance);
/** Wait for a transition of `rule` on `instance` newer than `since` (unix seconds). */
const waitTransition = (rule, instance, state, since, what) => {
  let seen;
  return waitFor(async () => {
    seen = of(await transitions(), rule, instance);
    return seen.find((x) => x.state === state && x.t > since);
  }, { timeout: 40_000, what: `${rule} on ${instance} ${state}: ${what}`, describe: () => seen });
};
const firingCount = async (rule, instance) => of(await transitions(), rule, instance).filter((x) => x.state === "firing").length;

test("a new install has default rules; rules are saved with mode 600", async () => {
  const r = await c.get("/api/alerts/rules");
  assert.equal(r.status, 200);
  const kinds = r.data.rules.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["agent_unreachable", "context_short", "disk", "gpu_lost", "gpu_temp", "host_unreachable", "insecure", "ollama_crash", "reload_churn", "vram"]);
  assert.equal(r.data.rules.find((x) => x.kind === "vram").enabled, false);
  assert.equal(r.data.rules.find((x) => x.kind === "context_short").enabled, false);

  const put = await c.put("/api/alerts/rules", { rules: RULES });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.rules.map((x) => x.id), RULES.map((x) => x.id));
  assert.equal(put.data.rules.find((x) => x.id === "down").hosts, null);
  const file = path.join(stack.data.data, "alert-rules.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("invalid rules are refused and change nothing", async () => {
  for (const bad of [
    [{ kind: "nope" }],
    [{ kind: "gpu_temp", threshold: 0 }],
    [{ kind: "disk", threshold: 101 }],
    [{ kind: "disk", for_s: -1 }],
    [{ kind: "disk", hosts: ["no-such-host"] }],
    [{ id: "x", kind: "disk" }, { id: "x", kind: "vram" }],
  ]) {
    const r = await c.put("/api/alerts/rules", { rules: bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)} → ${JSON.stringify(r.data)}`);
  }
  assert.deepEqual((await c.get("/api/alerts/rules")).data.rules.map((x) => x.id), RULES.map((x) => x.id));
});

test("a threshold has to hold for the rule's duration, then fires; once clear long enough it resolves", async () => {
  const start = now();
  await sim.scenario("sim-1", { gpu_temp: 92 });
  const pending = await waitFor(async () => (await active()).find((a) => a.rule === "hot" && a.instance === "sim-1"), { what: "a pending alert" });
  assert.equal(pending.state, "pending");
  assert.equal(pending.subject, "gpu0");

  const fired = await waitTransition("hot", "sim-1", "firing", start, "fires");
  assert.ok(fired.t - pending.since >= 3, `fired ${fired.t - pending.since}s after the condition was first seen`);
  assert.equal(fired.value, 92);
  assert.match(fired.detail, /GPU0 .* at 92°C/);
  assert.equal(fired.flapping, false);
  const a = (await active()).find((x) => x.rule === "hot");
  assert.equal(a.state, "firing");

  const cooled = now();
  await sim.scenario("sim-1", { gpu_temp: null });
  const resolved = await waitTransition("hot", "sim-1", "resolved", cooled, "resolves");
  assert.ok(resolved.t - cooled >= 2 - 1.5, `resolved ${resolved.t - cooled}s after cooling down`);
  assert.ok(!(await active()).some((x) => x.rule === "hot"));
  assert.equal(await firingCount("hot", "sim-1"), 1);
});

test("a rule for chosen hosts leaves the others alone", async () => {
  // "hot" covers sim-1 only; sim-2's own rule fires instead
  const start = now();
  await sim.scenario("sim-2", { gpu_temp: 95 });
  await waitTransition("flappy", "sim-2", "firing", start, "sim-2's own rule");
  await sleep(4000);
  assert.equal(of(await transitions(), "hot", "sim-2").length, 0);
  const cooled = now();
  await sim.scenario("sim-2", { gpu_temp: null });
  await waitTransition("flappy", "sim-2", "resolved", cooled, "resolves");
});

test("the filesystem holding the models directory counts as a disk", async () => {
  const start = now();
  await sim.scenario("sim-2", { models_disk_pct: 97 });
  const fired = await waitTransition("disk", "sim-2", "firing", start, "models disk full");
  assert.equal(fired.subject, "/srv/ollama/models");
  assert.equal(fired.value, 97);
  // the root filesystem isn't full, so it has no alert of its own
  assert.ok(!(await active()).some((a) => a.rule === "disk" && a.subject === "/"));
  const freed = now();
  await sim.scenario("sim-2", { models_disk_pct: 40 });
  await waitTransition("disk", "sim-2", "resolved", freed, "space freed");
});

test("an alert that keeps firing is marked flapping and has to stay clear longer", async () => {
  // two quick fire/resolve cycles, then a third firing in the same half hour (the earlier test added one)
  for (let i = 0; i < 2; i++) {
    const hot = now();
    await sim.scenario("sim-2", { gpu_temp: 95 });
    await waitTransition("flappy", "sim-2", "firing", hot, `cycle ${i + 1}`);
    const cool = now();
    await sim.scenario("sim-2", { gpu_temp: null });
    await waitTransition("flappy", "sim-2", "resolved", cool, `cycle ${i + 1}`);
  }
  const hot = now();
  await sim.scenario("sim-2", { gpu_temp: 95 });
  const fired = await waitTransition("flappy", "sim-2", "firing", hot, "flapping");
  assert.equal(fired.flapping, true);
  assert.equal((await active()).find((a) => a.rule === "flappy").flapping, true);

  const cool = now();
  await sim.scenario("sim-2", { gpu_temp: null });
  // clear_s is 1s, but a flapping alert has to stay clear for 10× that
  await sleep(5000);
  assert.equal(of(await transitions(), "flappy", "sim-2").filter((x) => x.state === "resolved" && x.t > cool).length, 0, "not resolved yet");
  const resolved = await waitTransition("flappy", "sim-2", "resolved", cool, "resolves after the longer hold");
  assert.ok(resolved.t - cool >= 9, `resolved after ${resolved.t - cool}s`);
});

test("an unreachable host fires, and resolves when it's back", async () => {
  const start = now();
  // agent first: with the agent up, Ollama going away would be a crash, not an unreachable host
  await sim.scenario("sim-2", { agent: "down" });
  await sim.scenario("sim-2", { ollama: "down" });
  const fired = await waitTransition("down", "sim-2", "firing", start, "host unreachable");
  assert.match(fired.detail, /Ollama: ollama unreachable/);
  assert.match(fired.detail, /agent: agent unreachable/);
  assert.equal(of(await transitions(), "crash", "sim-2").filter((x) => x.t > start).length, 0, "no crash without the agent to tell");
  assert.equal(of(await transitions(), "down", "sim-1").length, 0, "the other host is fine");

  const back = now();
  await sim.scenario("sim-2", { ollama: "up" });
  await sim.scenario("sim-2", { agent: "up" });
  await waitTransition("down", "sim-2", "resolved", back, "host back");
});

test("missing observations neither resolve a firing alert nor fire a new one", async () => {
  // a firing alert whose data goes away stays firing, marked unknown, even after the cause is gone
  let start = now();
  await sim.scenario("sim-1", { gpu_temp: 92 });
  await waitTransition("hot", "sim-1", "firing", start, "fires");
  const gone = now();
  await sim.scenario("sim-1", { agent: "down" });
  await waitFor(async () => (await active()).find((a) => a.rule === "hot" && a.unknown), { what: "the alert to become unknown" });
  await sim.scenario("sim-1", { gpu_temp: null });
  await sleep(5000);
  assert.equal(of(await transitions(), "hot", "sim-1").filter((x) => x.t > gone).length, 0, "nothing resolved without data");
  const a = (await active()).find((x) => x.rule === "hot");
  assert.equal(a.state, "firing");
  assert.equal(a.unknown, true);

  // once data is back and clear, it resolves after clear_s as usual
  const back = now();
  await sim.scenario("sim-1", { agent: "up" });
  const resolved = await waitTransition("hot", "sim-1", "resolved", back, "resolves once data is back");
  assert.ok(resolved.t - back >= 1, `resolved ${resolved.t - back}s after the agent came back`);

  // a condition that only held while nobody could see it doesn't fire, and its duration starts when it's seen
  await sim.scenario("sim-1", { agent: "down" });
  await c.waitInstance("sim-1", (x) => !x.agent_ok, "agent down");
  await sim.scenario("sim-1", { gpu_temp: 92 });
  start = now();
  await sleep(5000);
  assert.ok(!(await active()).some((x) => x.rule === "hot"), "no pending or firing alert without data");
  assert.equal(of(await transitions(), "hot", "sim-1").filter((x) => x.t > start).length, 0);
  const seen = now();
  await sim.scenario("sim-1", { agent: "up" });
  const fired = await waitTransition("hot", "sim-1", "firing", seen, "fires once seen for long enough");
  assert.ok(fired.t - seen >= 3 - 1, `fired ${fired.t - seen}s after the agent came back`);
});

test("a dashboard restart keeps firing alerts without firing them again", async () => {
  const before = await firingCount("hot", "sim-1");
  assert.ok((await active()).some((a) => a.rule === "hot" && a.state === "firing"));
  await stack.dashboard.stop();
  // the GPU cools down while the dashboard isn't watching
  await sim.scenario("sim-1", { gpu_temp: null });
  await sleep(2000);
  stack.dashboard = await startDashboard(stack.data, { port: stack.dashboard.port });
  const c2 = new Client(stack.dashboard.url);
  c2.cookie = c.cookie;
  c = c2;
  const restarted = now();

  const a = (await active()).find((x) => x.rule === "hot" && x.instance === "sim-1");
  assert.ok(a, "the firing alert is back after the restart");
  assert.equal(a.state, "firing");
  // the cool-down happened while nobody watched, so it has to be seen for clear_s first
  const resolved = await waitTransition("hot", "sim-1", "resolved", restarted - 1, "resolves after the restart");
  assert.ok(resolved.t - restarted >= 1, `resolved ${resolved.t - restarted}s after the restart`);
  assert.equal(await firingCount("hot", "sim-1"), before, "no second firing");
  // rules survive the restart too
  assert.deepEqual((await c.get("/api/alerts/rules")).data.rules.map((x) => x.id), RULES.map((x) => x.id));
});

test("Ollama crashing fires at once; a restart from the dashboard doesn't", async () => {
  await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
  // a couple of polls, so the dashboard knows the current Ollama process
  await sleep(2500);
  let start = now();
  await sim.scenario("sim-1", { crash: "ollama" });
  const fired = await waitTransition("crash", "sim-1", "firing", start, "Ollama crashed");
  assert.match(fired.detail, /Ollama restarted|process exited|API is down/);
  await waitTransition("crash", "sim-1", "resolved", fired.t, "Ollama running again");

  await sleep(2500);
  start = now();
  const r = await c.post("/api/instances/sim-1/restart");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await sleep(5000);
  assert.equal(of(await transitions(), "crash", "sim-1").filter((x) => x.t > start).length, 0, "a requested restart isn't a crash");
  assert.equal(of(await transitions(), "down", "sim-1").filter((x) => x.t > start).length, 0);
});

test("a model's runner exiting fires", async () => {
  const h = sim.host("sim-1");
  const load = await fetch(`${h.ollama_url}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama3.2:3b", keep_alive: "10m", stream: false }),
  });
  assert.equal(load.status, 200);
  await c.waitInstance("sim-1", (x) => x.ps.length === 1 && x.stats.system.ollama_process?.runners === 1, "a model with its runner");
  await sleep(1500);
  const start = now();
  await sim.scenario("sim-1", { crash: "runner" });
  const fired = await waitTransition("crash", "sim-1", "firing", start, "runner exited");
  assert.match(fired.detail, /0 runner processes for 1 loaded model: a runner exited/);
});
