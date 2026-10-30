// The real Linux agent in PADDOCK_DRY_RUN mode, next to the simulator's Ollama: checks that the
// dashboard works with it, and that the simulated agent answers with the same shapes and the same
// env-name rules, so the other scenarios aren't testing against a simulator that has drifted.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  Client, REPO, freeSimPort, makeDataDir, scenarioTest, startDashboard, startProcess, startSim, waitFor,
} from "./harness.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
const TOKEN = "real-agent-token";
let c, sim, agentUrl, simAgentUrl, agentProc, data;

before(async () => {
  const stack = { failed: false };
  holder.stack = stack;
  stack.stop = async () => {
    if (stack.failed) for (const p of [stack.dashboard?.child, agentProc, sim?.child]) if (p) console.error(`--- last output of ${p.name}:\n${p.tail(60)}`);
    await Promise.allSettled([stack.dashboard?.stop(), agentProc?.stop(), sim?.stop()]);
    data?.remove();
  };
  // sim-1 has no GPUs, like a CI runner without nvidia-smi, so it can be compared with the real agent
  sim = await startSim({ hosts: 2, gpus: "0,1" });
  simAgentUrl = sim.host("sim-1").agent_url;
  const port = await freeSimPort();
  data = makeDataDir(sim, { instances: { "sim-1": { agent_url: `http://127.0.0.1:${port}`, agent_token: TOKEN } } });
  agentProc = startProcess("agent", [path.join(REPO, "agent/linux/paddock-agent.mjs")], {
    cwd: data.dir,
    env: {
      ...process.env, PADDOCK_AGENT_TOKEN: TOKEN, PADDOCK_AGENT_BIND: "127.0.0.1", PADDOCK_AGENT_PORT: String(port),
      PADDOCK_DRY_RUN: "1", PADDOCK_OVERRIDE_PATH: path.join(data.dir, "override.conf"),
    },
  });
  agentUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (!agentProc.running) throw new Error(`agent exited:\n${agentProc.tail()}`);
    return (await fetch(`${agentUrl}/health`)).ok;
  }, { timeout: 15_000, what: "the agent to start" });
  stack.dashboard = await startDashboard(data);
  c = await new Client(stack.dashboard.url).login();
});
after(() => holder.stack?.stop());

const call = async (base, token, method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
};
const real = (method, p, body) => call(agentUrl, TOKEN, method, p, body);
const simulated = (method, p, body) => call(simAgentUrl, "sim-token", method, p, body);
const keys = (o) => Object.keys(o).sort();

test("the dashboard polls the real agent", async () => {
  const i = await c.waitInstance("sim-1", (x) => x.ollama_ok && x.agent_ok, "online");
  const src = fs.readFileSync(path.join(REPO, "agent/linux/paddock-agent.mjs"), "utf8");
  assert.equal(i.agent_version, /const VERSION = "([^"]+)"/.exec(src)[1]);
  assert.equal(i.stats.platform, "linux");
  assert.equal(i.stats.service.active, "dry-run");
});

test("env, restart and logs go through to the real agent", async () => {
  const put = await c.put("/api/instances/sim-1/env", { vars: { OLLAMA_KEEP_ALIVE: "10m" }, restart: true });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.restart, { ok: true, dry_run: true });
  const env = await c.get("/api/instances/sim-1/env");
  assert.equal(env.data.managed.OLLAMA_KEEP_ALIVE, "10m");

  const denied = await c.put("/api/instances/sim-1/env", { vars: { LD_PRELOAD: "/tmp/x.so" } });
  assert.equal(denied.status, 400);
  assert.match(denied.data.detail, /not an Ollama variable/);

  assert.equal((await c.post("/api/instances/sim-1/restart")).status, 200);
  const logs = await c.get("/api/instances/sim-1/logs");
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.data.lines));
});

test("the simulated agent answers with the real agent's shapes", async () => {
  const [rh, sh] = await Promise.all([fetch(`${agentUrl}/health`).then((r) => r.json()), fetch(`${simAgentUrl}/health`).then((r) => r.json())]);
  assert.deepEqual(keys(sh), keys(rh), "/health");

  const [rs, ss] = await Promise.all([real("GET", "/stats"), simulated("GET", "/stats")]);
  assert.deepEqual(keys(ss.data), keys(rs.data), "/stats");
  assert.deepEqual(keys(ss.data.system), keys(rs.data.system), "/stats system");
  assert.deepEqual(keys(ss.data.system.mem), keys(rs.data.system.mem), "/stats system.mem");
  assert.deepEqual(keys(ss.data.system.net), keys(rs.data.system.net), "/stats system.net");
  assert.deepEqual(keys(ss.data.system.disks[0]), keys(rs.data.system.disks[0]), "/stats system.disks");
  assert.deepEqual(keys(ss.data.nvidia).filter((k) => k !== "error"), keys(rs.data.nvidia).filter((k) => k !== "error"), "/stats nvidia");
  // dry run reports only part of the service status; the simulator's must still cover it
  for (const k of keys(rs.data.service)) assert.ok(k in ss.data.service, `/stats service.${k}`);

  const [re, se] = await Promise.all([real("GET", "/env"), simulated("GET", "/env")]);
  assert.deepEqual(keys(se.data), keys(re.data), "/env");
  assert.deepEqual(se.data.allowed, re.data.allowed, "the same env-name allowlist");

  const [rl, sl] = await Promise.all([real("GET", "/logs?lines=10"), simulated("GET", "/logs?lines=10")]);
  assert.deepEqual(keys(sl.data), keys(rl.data), "/logs");
});

test("simulated GPUs have the fields the agents read from nvidia-smi", async () => {
  const src = fs.readFileSync(path.join(REPO, "agent/linux/paddock-agent.mjs"), "utf8");
  const gpuKeys = JSON.parse(`[${/const GPU_KEYS = \[([\s\S]*?)\];/.exec(src)[1].trim().replace(/,$/, "")}]`);
  // a loaded model gives the GPU a process too
  const load = await fetch(`${sim.host("sim-2").ollama_url}/api/generate`, { method: "POST", body: JSON.stringify({ model: "llama3.2:3b", stream: false }) });
  assert.equal(load.status, 200);
  const stats = await call(sim.host("sim-2").agent_url, "sim-token", "GET", "/stats");
  assert.equal(stats.data.nvidia.gpus.length, 1);
  assert.deepEqual(keys(stats.data.nvidia.gpus[0]), [...gpuKeys].sort());
  assert.deepEqual(keys(stats.data.nvidia.processes[0]), ["gpu_uuid", "mem_mib", "name", "pid"]);
});

test("the simulated agent applies the real agent's env rules", async () => {
  const cases = [
    { vars: { LD_PRELOAD: "/tmp/x.so" } },
    { vars: { "bad-name": "1" } },
    { vars: { OLLAMA_DEBUG: 1 } },
    { vars: { OLLAMA_DEBUG: "1\nExecStart=/bin/sh" } },
    { vars: ["OLLAMA_DEBUG"] },
  ];
  for (const body of cases) {
    const [r, s] = await Promise.all([real("PUT", "/env", { ...body, restart: false }), simulated("PUT", "/env", { ...body, restart: false })]);
    assert.equal(s.status, r.status, JSON.stringify(body));
    assert.equal(s.data.detail, r.data.detail, JSON.stringify(body));
  }
  const [r, s] = await Promise.all([
    real("PUT", "/env", { vars: { OLLAMA_DEBUG: "1" }, restart: false }),
    simulated("PUT", "/env", { vars: { OLLAMA_DEBUG: "1" }, restart: false }),
  ]);
  assert.equal(s.status, 200);
  assert.deepEqual(keys(s.data), keys(r.data));

  for (const [base, token] of [[agentUrl, "wrong"], [simAgentUrl, "wrong"]]) {
    const denied = await call(base, token, "GET", "/stats");
    assert.equal(denied.status, 401);
    assert.equal(denied.data.detail, "invalid agent token");
  }
});
