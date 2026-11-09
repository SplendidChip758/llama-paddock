// The real Linux agent (test/agent.mjs) in PADDOCK_DRY_RUN mode, next to the simulator's Ollama: checks that the
// dashboard works with it, and that the simulated agent answers with the same shapes and the same
// env-name rules, so the other scenarios aren't testing against a simulator that has drifted.
import { after, before, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Client, freeSimPort, makeDataDir, scenarioTest, startDashboard, startProcess, startSim, waitFor,
} from "./harness.mjs";
import { fetchAgent } from "../agent.mjs";

const holder = {};
const test = scenarioTest(nodeTest, holder);
const TOKEN = "real-agent-token";
let c, sim, agentUrl, simAgentUrl, agentProc, data;
/** the agent release in test/agent-release, or PADDOCK_AGENT_SRC's */
const AGENT = await fetchAgent();

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
  agentProc = startProcess("agent", [AGENT], {
    cwd: data.dir,
    env: {
      ...process.env, PADDOCK_AGENT_TOKEN: TOKEN, PADDOCK_AGENT_BIND: "127.0.0.1", PADDOCK_AGENT_PORT: String(port),
      PADDOCK_DRY_RUN: "1", PADDOCK_OVERRIDE_PATH: path.join(data.dir, "override.conf"),
      PADDOCK_AGENT_TLS_KEY: path.join(data.dir, "agent.key"), PADDOCK_AGENT_TLS_CERT: path.join(data.dir, "agent.crt"),
      // dry run reads no journal: Ollama's request log comes from this file instead
      PADDOCK_OLLAMA_LOG: writeOllamaLog(path.join(data.dir, "ollama.log")),
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

/** gin's line start at unix time `t`: local time without a zone, in whole seconds. */
function ginAt(t) {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date(t * 1000);
  return `[GIN] ${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} - ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Ollama's log as gin writes it: two requests, a monitoring call, a line it can't read, and noise. */
function writeOllamaLog(file) {
  const gin = (ago) => ginAt(Date.now() / 1000 - ago);
  fs.writeFileSync(file, [
    'time=2026-11-02T09:00:00 level=INFO source=routes.go msg="Listening on [::]:11434"',
    `${gin(120)} | 200 |  2.512345s |   192.168.30.30 | POST     "/api/chat"`,
    `${gin(90)} | 200 |     812.4µs |       127.0.0.1 | GET      "/api/ps"`,
    `${gin(60)} | 500 |  1m0.25s |   192.168.30.31 | POST     "/v1/chat/completions?stream=true"`,
    `${gin(30)} 200 a request line from a newer Ollama`,
  ].join("\n") + "\n");
  return file;
}

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
  const src = fs.readFileSync(AGENT, "utf8");
  assert.equal(i.agent_version, /const VERSION = "([^"]+)"/.exec(src)[1]);
  assert.equal(i.stats.platform, "linux");
  assert.equal(i.stats.service.active, "dry-run");
});

test("the real agent serves HTTPS on the same port, with the key it reports", async () => {
  const health = await fetch(`${agentUrl}/health`).then((r) => r.json());
  assert.match(health.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  const form = { ollama_url: sim.host("sim-1").ollama_url, agent_url: agentUrl.replace("http:", "https:"), agent_token: TOKEN };
  const ok = await c.post("/api/test-connection", { ...form, agent_fingerprint: health.fingerprint });
  assert.equal(ok.data.agent.ok, true, JSON.stringify(ok.data));
  assert.equal(ok.data.agent.fingerprint, health.fingerprint);
  // the certificate it made: signed with its own key, no expiry, and the key readable only by its owner
  const cert = new crypto.X509Certificate(fs.readFileSync(path.join(data.dir, "agent.crt")));
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(new Date(cert.validTo).getUTCFullYear(), 9999);
  assert.equal(fs.statSync(path.join(data.dir, "agent.key")).mode & 0o777, 0o600);
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

  const [rg, sg] = await Promise.all([real("GET", "/gpu-check"), simulated("GET", "/gpu-check")]);
  assert.deepEqual(keys(sg.data), keys(rg.data), "/gpu-check");
  // dry run can't read the journal, so it reports why
  assert.deepEqual(keys(sg.data.log), keys(rg.data.log).filter((k) => k !== "error"), "/gpu-check log");
  assert.deepEqual(keys(sg.data.nvidia_uvm), keys(rg.data.nvidia_uvm), "/gpu-check nvidia_uvm");
  const [rrs, srs] = await Promise.all([real("GET", "/runner-starts?since=0"), simulated("GET", "/runner-starts?since=0")]);
  assert.deepEqual(keys(srs.data), keys(rrs.data).filter((k) => k !== "error"), "/runner-starts");
  // no NVIDIA driver on either, so neither reloads
  const [rr, sr] = await Promise.all([real("POST", "/gpu/reload-uvm"), simulated("POST", "/gpu/reload-uvm")]);
  assert.equal(sr.status, rr.status, JSON.stringify(rr.data));
  const since = Date.now() / 1000 - 3600;
  const [rq, sq] = await Promise.all([real("GET", `/requests?since=${since}`), simulated("GET", `/requests?since=${since}`)]);
  assert.deepEqual(keys(sq.data), keys(rq.data), "/requests");
  assert.deepEqual(keys(sq.data.requests[0] ?? rq.data.requests[0]), keys(rq.data.requests[0]), "/requests requests[]");
});

test("the real agent reads Ollama's request log; the dashboard stores it and counts unreadable lines", async () => {
  const r = await real("GET", `/requests?since=${Date.now() / 1000 - 3600}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.skipped, 1, "the line in an unknown format is skipped");
  assert.deepEqual(r.data.requests.map((x) => `${x.status} ${x.client} ${x.method} ${x.path}`), [
    "200 192.168.30.30 POST /api/chat",
    "200 127.0.0.1 GET /api/ps",
    "500 192.168.30.31 POST /v1/chat/completions",
  ]);
  assert.equal(r.data.requests[0].duration_ms, 2512.345);
  assert.equal(r.data.requests[2].duration_ms, 60250);
  assert.ok(Math.abs(Date.now() / 1000 - 120 - r.data.requests[0].t) < 5, "gin's local time is read as local time");

  // the dashboard reads it every 10 polls; the monitoring call isn't stored
  const s = await waitFor(async () => {
    const x = (await c.get("/api/instances/sim-1/requests?range=1h")).data;
    return x.total?.count >= 2 && x;
  }, { timeout: 40_000, what: "the dashboard to store the real agent's requests" });
  assert.equal(s.total.count, 2);
  assert.equal(s.total.errors, 1);
  assert.ok(s.sync.skipped >= 1);
});

test("a request logged later in the second a read ended comes with the next read", async () => {
  const first = await real("GET", `/requests?since=${Date.now() / 1000 - 3600}`);
  const until = first.data.until;
  // gin stamps it with that second, which is before `until`
  fs.appendFileSync(path.join(data.dir, "ollama.log"), `${ginAt(Math.floor(until))} | 200 |  1.5s |   192.168.30.32 | POST     "/api/generate"\n`);
  const next = await real("GET", `/requests?since=${until}`);
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.deepEqual(next.data.requests.map((x) => `${x.client} ${x.path}`), ["192.168.30.32 /api/generate"], "and the older lines don't come again");
});

test("simulated GPUs have the fields the agents read from nvidia-smi", async () => {
  const src = fs.readFileSync(AGENT, "utf8");
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
