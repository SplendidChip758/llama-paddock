// Shared helpers for the scenario tests: start the simulator and the built standalone dashboard,
// sign in through the API, and wait for conditions with deadlines instead of fixed sleeps.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DASHBOARD = path.join(REPO, "dashboard");
const STANDALONE = path.join(DASHBOARD, ".next/standalone");

export const USERNAME = "admin";
export const INITIAL_PASSWORD = "initial-password-1";
export const PASSWORD = "scenario-password-1";

// Port ranges, overridable so parallel jobs on one machine can be kept apart.
const range = (env, def) => (process.env[env] || def).split("-").map(Number);
const DASHBOARD_PORTS = range("PADDOCK_TEST_DASHBOARD_PORTS", "18100-18119");
const SIM_PORTS = range("PADDOCK_TEST_SIM_PORTS", "11700-11799");

// ============================================================================ processes
const children = new Set();
// a test file that crashes or times out must not leave a dashboard or simulator running
process.on("exit", () => {
  for (const c of children) c.kill("SIGKILL");
});

function canListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** The first run of `n` free consecutive ports in [from, to]. */
async function freePorts(n, [from, to]) {
  for (let base = from; base + n - 1 <= to; base++) {
    let ok = true;
    for (let p = base; p < base + n && ok; p++) ok = await canListen(p);
    if (ok) return base;
  }
  throw new Error(`no ${n} free consecutive ports in ${from}-${to}`);
}

class Child {
  constructor(name, cmd, args, opts) {
    this.name = name;
    this.output = "";
    this.proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    children.add(this.proc);
    const keep = (d) => {
      this.output += d;
      if (process.env.PADDOCK_TEST_VERBOSE) process.stderr.write(`[${name}] ${d}`);
      // only the tail matters when something fails
      if (this.output.length > 200_000) this.output = this.output.slice(-100_000);
    };
    this.proc.stdout.on("data", keep);
    this.proc.stderr.on("data", keep);
    this.exited = new Promise((resolve) => this.proc.once("exit", (code, signal) => {
      children.delete(this.proc);
      resolve({ code, signal });
    }));
  }

  get running() {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** SIGTERM, then SIGKILL if it hasn't exited after `graceMs`. */
  async stop(graceMs = 10_000) {
    if (!this.running) return this.exited;
    this.proc.kill("SIGTERM");
    const timer = setTimeout(() => this.proc.kill("SIGKILL"), graceMs);
    const result = await this.exited;
    clearTimeout(timer);
    return result;
  }

  tail(lines = 40) {
    return this.output.split("\n").slice(-lines).join("\n");
  }
}

/** A free port for an extra process (such as a real agent), from the simulator's range. */
export const freeSimPort = () => freePorts(1, SIM_PORTS);

/** Run a long-lived helper process that the harness kills on exit, like the dashboard and simulator. */
export const startProcess = (name, args, opts) => new Child(name, process.execPath, args, opts);

// ============================================================================ waiting
/**
 * Call `fn` until it returns something truthy (errors count as "not yet"), or fail after `timeout` ms.
 * The error carries the last value or error seen (or `describe()`), so a failure says what the test saw.
 */
export async function waitFor(fn, { timeout = 30_000, interval = 250, what = "condition", describe } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      const detail = describe ? JSON.stringify(describe()) : last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`timed out after ${timeout} ms waiting for ${what}; last seen: ${String(detail).slice(0, 2000)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

// ============================================================================ simulator
export async function startSim({ hosts = 1, gpus = "1", ollamaKey = "", agentToken = "sim-token", pullSeconds = 3 } = {}) {
  const basePort = await freePorts(1 + hosts * 2, SIM_PORTS);
  const child = new Child("sim", process.execPath, [
    path.join(REPO, "test/sim/paddock-sim.mjs"),
    "--hosts", String(hosts), "--base-port", String(basePort), "--gpus", String(gpus),
    "--agent-token", agentToken, "--ollama-key", ollamaKey, "--pull-seconds", String(pullSeconds),
  ], { cwd: REPO, env: { ...process.env } });
  const control = `http://127.0.0.1:${basePort}/_sim`;
  const list = await waitFor(async () => {
    if (!child.running) throw new Error(`simulator exited:\n${child.tail()}`);
    const r = await fetch(`${control}/hosts`);
    return r.ok && (await r.json()).hosts;
  }, { timeout: 15_000, what: "the simulator to start" });

  return {
    child,
    hosts: list,
    host: (id) => list.find((h) => h.id === id),
    async state(id) {
      const r = await fetch(`${control}/hosts/${id}`);
      if (!r.ok) throw new Error(`sim state ${id}: ${r.status} ${await r.text()}`);
      return r.json();
    },
    async scenario(id, patch) {
      const r = await fetch(`${control}/hosts/${id}/scenario`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`sim scenario ${id}: ${r.status} ${await r.text()}`);
      return r.json();
    },
    stop: () => child.stop(),
  };
}

// ============================================================================ dashboard
/** A temp data dir, plus a config.yaml listing the simulator's hosts (instances: per-host overrides). */
export function makeDataDir(sim, { instances = {}, pollInterval = 1, extra = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-scenario-"));
  const data = path.join(dir, "data");
  fs.mkdirSync(data, { mode: 0o700 });
  const lines = [`poll_interval: ${pollInterval}`, "metrics_open: true", extra, "instances:"];
  for (const h of sim.hosts) {
    const o = { id: h.id, name: h.id, ollama_url: h.ollama_url, ollama_proxy_key: h.ollama_key, agent_url: h.agent_url, agent_token: h.agent_token, ...instances[h.id] };
    lines.push(`  - id: ${o.id}`);
    for (const k of ["name", "ollama_url", "ollama_proxy_key", "agent_url", "agent_token", "agent_fingerprint"]) if (o[k]) lines.push(`    ${k}: ${JSON.stringify(o[k])}`);
  }
  const config = path.join(dir, "config.yaml");
  fs.writeFileSync(config, lines.join("\n") + "\n", { mode: 0o600 });
  return {
    dir, data, config,
    remove: () => !process.env.PADDOCK_TEST_KEEP && fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function prepareStandalone() {
  const server = path.join(STANDALONE, "server.js");
  if (!fs.existsSync(server)) throw new Error(`${server} is missing: run "npm run build" in dashboard/ first`);
  // the standalone output leaves the static assets out; copy them as the Dockerfile does
  const staticDir = path.join(STANDALONE, ".next/static");
  if (!fs.existsSync(staticDir)) fs.cpSync(path.join(DASHBOARD, ".next/static"), staticDir, { recursive: true });
  return server;
}

export async function startDashboard(dataDir, { port } = {}) {
  const server = prepareStandalone();
  port ??= await freePorts(1, DASHBOARD_PORTS);
  const env = { ...process.env };
  // whatever the developer has set for their own dashboard must not leak into the test one
  for (const k of Object.keys(env)) if (k.startsWith("PADDOCK_")) delete env[k];
  Object.assign(env, {
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    PADDOCK_DATA_DIR: dataDir.data,
    PADDOCK_CONFIG: dataDir.config,
    PADDOCK_USERNAME: USERNAME,
    PADDOCK_PASSWORD: INITIAL_PASSWORD,
  });
  const child = new Child("dashboard", process.execPath, [server], { cwd: STANDALONE, env });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (!child.running) throw new Error(`dashboard exited:\n${child.tail()}`);
    return (await fetch(`${url}/api/healthz`)).ok;
  }, { timeout: 60_000, interval: 300, what: "the dashboard to start" });
  return { child, url, port, stop: () => child.stop() };
}

// ============================================================================ API client
/** Talks to the dashboard's JSON API with a session cookie, like the browser does. */
export class Client {
  constructor(url) {
    this.url = url;
    this.cookie = null;
  }

  async request(method, p, body) {
    const headers = {};
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(this.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) {
      const m = /^paddock_session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? `paddock_session=${m[1]}` : null;
    }
    const text = await r.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // /metrics is text
    }
    return { status: r.status, data };
  }

  get = (p) => this.request("GET", p);
  post = (p, body = {}) => this.request("POST", p, body);
  put = (p, body = {}) => this.request("PUT", p, body);
  del = (p) => this.request("DELETE", p);

  /** Sign in; on the first login also do the forced password change. */
  async login() {
    let r = await this.post("/api/auth/login", { username: USERNAME, password: PASSWORD });
    if (r.status === 401) {
      r = await this.post("/api/auth/login", { username: USERNAME, password: INITIAL_PASSWORD });
      if (r.status !== 200 || !r.data.must_change) throw new Error(`first login failed: ${r.status} ${JSON.stringify(r.data)}`);
      const blocked = await this.get("/api/instances");
      if (blocked.status !== 403) throw new Error(`expected the API to be blocked until the password is changed, got ${blocked.status}`);
      r = await this.post("/api/auth/password", { password: PASSWORD });
    }
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.data)}`);
    return this;
  }

  async instance(id) {
    const r = await this.get("/api/instances");
    if (r.status !== 200) throw new Error(`/api/instances: ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.instances.find((i) => i.id === id);
  }

  async job(jid) {
    const r = await this.get("/api/jobs");
    return r.data.jobs.find((j) => j.id === jid);
  }

  /** Wait for a polled instance to match `pred`. Polls run every second, so allow a few. */
  waitInstance(id, pred, what, timeout = 30_000) {
    let seen;
    return waitFor(async () => {
      seen = await this.instance(id);
      return pred(seen) && seen;
    }, {
      timeout, what: `${id}: ${what}`,
      describe: () => seen && { ollama_ok: seen.ollama_ok, ollama_error: seen.ollama_error, agent_ok: seen.agent_ok, agent_error: seen.agent_error },
    });
  }

  waitJob(jid, pred, what, timeout = 60_000) {
    let seen;
    return waitFor(async () => {
      seen = await this.job(jid);
      return seen && pred(seen) && seen;
    }, { timeout, what: `job ${jid}: ${what}`, describe: () => seen });
  }
}

/** One sample's value from /metrics text, or undefined. */
export function metric(text, name, labels) {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(name + "{")) continue;
    const inner = line.slice(name.length + 1, line.indexOf("}"));
    if (want.every((l) => inner.split(",").includes(l))) return Number(line.slice(line.indexOf("}") + 2));
  }
  return undefined;
}

/**
 * Start a simulator, a data dir and a signed-in dashboard. `data` can be a function of the simulator,
 * for config that depends on its ports. `stop()` tears all of it down and, when a
 * test marked the stack as failed, prints the processes' recent output, since CI only shows the assertion.
 */
export async function startStack({ sim: simOpts = {}, data: dataOpts = {} } = {}) {
  const stack = { sim: null, data: null, dashboard: null, client: null, failed: false };
  stack.stop = async () => {
    if (stack.failed) {
      for (const c of [stack.dashboard?.child, stack.sim?.child]) if (c) console.error(`--- last output of ${c.name}:\n${c.tail(60)}`);
    }
    await Promise.allSettled([stack.dashboard?.stop(), stack.sim?.stop()]);
    stack.data?.remove();
  };
  try {
    stack.sim = await startSim(simOpts);
    stack.data = makeDataDir(stack.sim, typeof dataOpts === "function" ? dataOpts(stack.sim) : dataOpts);
    stack.dashboard = await startDashboard(stack.data);
    stack.client = await new Client(stack.dashboard.url).login();
  } catch (e) {
    stack.failed = true;
    await stack.stop();
    throw e;
  }
  return stack;
}

/** `test()` that marks `holder.stack` as failed when it throws, so its teardown prints the process logs. */
export function scenarioTest(test, holder) {
  return (name, fn) => test(name, async (t) => {
    try {
      await fn(t);
    } catch (e) {
      if (holder.stack) holder.stack.failed = true;
      throw e;
    }
  });
}
