#!/usr/bin/env node
/**
 * llama-paddock simulator
 * =======================
 * Simulated Ollama hosts and agents, for developing the dashboard without a GPU
 * and for the scenario tests in test/scenarios/. Zero npm dependencies: plain
 * Node.js >= 22.
 *
 * Each simulated host gets two ports, because the dashboard addresses hosts by
 * URL: one serves Ollama's HTTP API (the parts the dashboard uses), the other the
 * agent API of agent/linux/paddock-agent.mjs (/health, /stats, /env, /logs,
 * /service/restart, with the same bearer-token rule). A third port serves the
 * control API, which switches failure scenarios at runtime.
 *
 * Ports, from --base-port B:   control = B,  host n (1-based):
 *                              Ollama  = B + 2n - 1,  agent = B + 2n
 *
 * Options (each also as an env var, e.g. --base-port → PADDOCK_SIM_BASE_PORT):
 *   --hosts N            simulated hosts (default 3)
 *   --base-port P        first port (default 11700)
 *   --bind ADDR          listen address (default 127.0.0.1; 0.0.0.0 to reach it from Docker)
 *   --gpus LIST          GPUs per host, one number for all or per host: "2,1,0" (default 1)
 *   --agent-token T      agent token for every host (default sim-token)
 *   --ollama-key LIST    require an Ollama API key: one key for all hosts, or per host
 *                        ("key1,,key3"; empty = no key). Default: none
 *   --pull-seconds S     how long a full model pull takes (default 8)
 *   --write-config FILE  write a dashboard config.yaml for these hosts and keep running
 *   --help
 *
 * Control API (no auth; it binds to --bind like everything else):
 *   GET  /_sim/hosts                    every host: URLs, credentials, scenario
 *   GET  /_sim/hosts/<id>               one host, plus its pull log and request counts
 *   POST /_sim/hosts/<id>/scenario      change behaviour, JSON body with any of:
 *        ollama:  "up" | "down" (port closed) | "hang" (never answers) | "error" (HTTP 500)
 *        agent:   "up" | "down" | "hang" | "error" | "bad-token" (401 for every token)
 *        pull:    "normal" | "stall" (stops making progress) | "fail" (error line mid-stream)
 *                 | "drop" (connection cut mid-stream)
 *        create:  "normal" | "stall" | "fail"
 *        pull_seconds, ollama_key (string or null), agent_token,
 *        ollama_version, agent_version (null: /stats leaves the version out, like agents before 0.6.0)
 *   GET  /_sim/config.yaml              the same config.yaml as --write-config
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ options
const HELP = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, "");

function options(argv) {
  const defaults = {
    hosts: "3", "base-port": "11700", bind: "127.0.0.1", gpus: "1", "agent-token": "sim-token",
    "ollama-key": "", "pull-seconds": "8", "write-config": "",
  };
  const opts = {};
  for (const k of Object.keys(defaults)) {
    const env = process.env[`PADDOCK_SIM_${k.toUpperCase().replace(/-/g, "_")}`];
    opts[k] = env ?? defaults[k];
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !(m[1] in defaults)) fail(`unknown option ${a} (see --help)`);
    opts[m[1]] = m[2] ?? argv[++i] ?? fail(`${a} needs a value`);
  }
  const int = (k, min) => {
    const n = Number(opts[k]);
    if (!Number.isInteger(n) || n < min) fail(`--${k} must be an integer >= ${min}`);
    return n;
  };
  const hosts = int("hosts", 1);
  const perHost = (s) => {
    const list = s.split(",").map((x) => x.trim());
    return Array.from({ length: hosts }, (_, i) => (list.length === 1 ? list[0] : list[i] ?? ""));
  };
  const gpus = perHost(opts.gpus).map((g) => {
    const n = Number(g || 0);
    if (!Number.isInteger(n) || n < 0 || n > 16) fail("--gpus must be numbers from 0 to 16");
    return n;
  });
  const pullSeconds = Number(opts["pull-seconds"]);
  if (!(pullSeconds > 0)) fail("--pull-seconds must be a positive number");
  return {
    hosts, basePort: int("base-port", 1), bind: opts.bind, gpus, agentToken: opts["agent-token"],
    ollamaKeys: perHost(opts["ollama-key"]).map((k) => k || null), pullSeconds, writeConfig: opts["write-config"],
  };
}

function fail(msg) {
  console.error(`paddock-sim: ${msg}`);
  process.exit(2);
}

// The agent version the sim reports by default: the one in the repository's agent, so the
// dashboard shows the same version as a freshly installed agent of this checkout.
function repoAgentVersion() {
  try {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../agent/linux/paddock-agent.mjs"), "utf8");
    return /const VERSION = "([^"]+)"/.exec(src)?.[1] ?? "0.0.0-sim";
  } catch {
    return "0.0.0-sim";
  }
}

// ------------------------------------------------------------------ helpers
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
/** A stable pseudo-random number in [0, 1) for a string, so sizes and digests don't change between runs. */
const unit = (s) => parseInt(hash(s).slice(0, 8), 16) / 2 ** 32;
/** Ollama treats "llama3.2" as "llama3.2:latest". */
const fullName = (name) => (/:[^/]+$/.test(name) ? name : `${name}:latest`);

/** Ollama's keep_alive: seconds as a number, or a duration such as "5m"; negative = forever. Returns ms or Infinity. */
function keepAliveMs(v, fallback = "5m") {
  v ??= fallback;
  if (typeof v === "number") return v < 0 ? Infinity : v * 1000;
  const m = /^(-?\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(v).trim());
  if (!m) return 5 * 60_000;
  const n = Number(m[1]);
  if (n < 0) return Infinity;
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
}

const FAMILIES = [
  { match: /embed/, family: "nomic-bert", arch: "nomic-bert", ctx: 2048, caps: ["embedding"] },
  { match: /qwen/, family: "qwen2", arch: "qwen2", ctx: 32768, caps: ["completion", "tools"] },
  { match: /gemma/, family: "gemma3", arch: "gemma3", ctx: 131072, caps: ["completion", "vision"] },
  { match: /./, family: "llama", arch: "llama", ctx: 131072, caps: ["completion", "tools"] },
];

/** A model as /api/tags would list it, made up from its name. */
function makeModel(name, extra = {}) {
  name = fullName(name);
  const f = FAMILIES.find((x) => x.match.test(name));
  const params = Number(/(\d+(?:\.\d+)?)b\b/i.exec(name)?.[1] ?? (1 + unit(name) * 7).toFixed(1));
  return {
    name,
    model: name,
    modified_at: new Date().toISOString(),
    // roughly a Q4_K_M file: ~0.6 bytes per parameter
    size: Math.round(params * 1e9 * 0.6 + unit(name + "s") * 2e8),
    digest: hash(name),
    details: {
      parent_model: "", format: "gguf", family: f.family, families: [f.family],
      parameter_size: `${params}B`, quantization_level: "Q4_K_M",
    },
    arch: f.arch,
    ctx: f.ctx,
    capabilities: f.caps,
    parameters: 'stop "<|eot_id|>"\ntemperature 0.7',
    template: "{{ .System }}\n{{ .Prompt }}",
    system: null,
    params: params * 1e9,
    ...extra,
  };
}

const tagView = (m) => ({ name: m.name, model: m.model, modified_at: m.modified_at, size: m.size, digest: m.digest, details: m.details });

// ------------------------------------------------------------------ host state
const SEED_MODELS = ["llama3.2:3b", "qwen2.5-coder:7b", "nomic-embed-text:latest"];
const GPU_MODEL = { name: "NVIDIA GeForce RTX 3090", mem: 24576, power: 350, smMax: 2100 };
const AGENT_ENV_ALLOW = [
  // the same allowlist as the agents' ENV_ALLOW
  "OLLAMA_*",
  "CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "GPU_DEVICE_ORDINAL",
  "HSA_OVERRIDE_GFX_VERSION", "GGML_CUDA_ENABLE_UNIFIED_MEMORY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
];
const envAllowed = (name) => AGENT_ENV_ALLOW.some((p) => p.endsWith("*")
  ? name.toUpperCase().startsWith(p.slice(0, -1).toUpperCase())
  : name.toUpperCase() === p.toUpperCase());
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OVERRIDE_PATH = "/etc/systemd/system/ollama.service.d/override.conf";

const SCENARIO_VALUES = {
  ollama: ["up", "down", "hang", "error"],
  agent: ["up", "down", "hang", "error", "bad-token"],
  pull: ["normal", "stall", "fail", "drop"],
  create: ["normal", "stall", "fail"],
};

function makeHost(n, o) {
  const id = `sim-${n}`;
  const h = {
    id,
    n,
    hostname: `sim-host-${n}`,
    ollamaPort: o.basePort + 2 * n - 1,
    agentPort: o.basePort + 2 * n,
    agentToken: o.agentToken,
    ollamaKey: o.ollamaKeys[n - 1],
    ollamaVersion: "0.12.6",
    agentVersion: repoAgentVersion(),
    pullSeconds: o.pullSeconds,
    scenario: { ollama: "up", agent: "up", pull: "normal", create: "normal" },
    gpus: Array.from({ length: o.gpus[n - 1] }, (_, i) => ({
      index: i, uuid: `GPU-${hash(`${id}/${i}`).slice(0, 8)}-${hash(`${id}/${i}`).slice(8, 12)}-sim0-${hash(`${id}/${i}`).slice(12, 24)}`,
    })),
    models: new Map(SEED_MODELS.map((name) => [name, makeModel(name)])),
    /** name → { until: ms timestamp or Infinity, ctx } */
    loaded: new Map(),
    /** model → bytes already downloaded, so a pull that was cut off resumes (Ollama keeps partial blobs) */
    partial: new Map(),
    env: { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_KEEP_ALIVE: "5m" },
    log: [],
    pulls: [],
    activePulls: 0,
    requests: {},
    restarts: 0,
    startedAt: Date.now(),
    pid: 1000 + n * 37,
    hung: new Set(),
    servers: {},
  };
  // the first host has something loaded, so the dashboard shows VRAM in use right away
  if (n === 1) h.loaded.set("llama3.2:3b", { until: Infinity, ctx: 4096 });
  logLine(h, `Listening on [::]:11434 (version ${h.ollamaVersion})`);
  return h;
}

function logLine(h, msg, level = "INFO") {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "+0000");
  h.log.push(`${ts} ${h.hostname} ollama[${h.pid}]: time=${new Date().toISOString()} level=${level} msg="${msg.replace(/"/g, "'")}"`);
  if (h.log.length > 2000) h.log.splice(0, h.log.length - 2000);
}

/** Loaded models as /api/ps reports them; drops the ones whose keep_alive ran out. */
function psModels(h) {
  const now = Date.now();
  const vramTotal = h.gpus.length * GPU_MODEL.mem * MiB;
  let vramFree = vramTotal;
  const out = [];
  for (const [name, l] of h.loaded) {
    const m = h.models.get(name);
    if (!m || l.until <= now) {
      h.loaded.delete(name);
      continue;
    }
    // file size plus KV cache for the context; spills into system RAM once the GPUs are full
    const size = m.size + l.ctx * 128 * 1024;
    const size_vram = Math.max(0, Math.min(size, vramFree));
    vramFree -= size_vram;
    out.push({
      name, model: name, size, digest: m.digest, details: m.details, size_vram, context_length: l.ctx,
      // Ollama reports a far-future date for keep_alive -1
      expires_at: new Date(l.until === Infinity ? Date.parse("2318-01-01T00:00:00Z") : l.until).toISOString(),
    });
  }
  return out;
}

// ------------------------------------------------------------------ Ollama API
class HttpErr extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpErr(413, "body too large");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpErr(400, "invalid JSON");
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Newline-delimited JSON, as Ollama streams pull/create progress. `gone()` is true once the client hung up. */
function ndjson(res) {
  let closed = false;
  res.on("close", () => (closed = true));
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  return {
    send: (obj) => !closed && res.write(JSON.stringify(obj) + "\n"),
    end: () => !closed && res.end(),
    gone: () => closed,
  };
}

function needModel(h, name) {
  const m = h.models.get(fullName(String(name ?? "")));
  if (!m) throw new HttpErr(404, `model '${name}' not found`);
  return m;
}

async function pull(h, body, res) {
  const name = fullName(String(body.model ?? body.name ?? ""));
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/.test(name)) throw new HttpErr(400, "invalid model name");
  const stream = body.stream !== false;
  const out = ndjson(res);
  const total = h.models.get(name)?.size ?? makeModel(name).size;
  const digest = `sha256:${hash(name)}`;
  const entry = { model: name, resumed_from: h.partial.get(name) ?? 0, completed: 0, total, outcome: "running", started: Date.now() / 1000 };
  h.pulls.push(entry);
  if (h.pulls.length > 200) h.pulls.shift();
  logLine(h, `pulling ${name}${entry.resumed_from ? ` (resuming at ${entry.resumed_from} bytes)` : ""}`);
  h.activePulls++;
  try {
    if (stream) out.send({ status: "pulling manifest" });
    let completed = entry.resumed_from;
    let progressSent = 0;
    const TICK = 200;
    while (completed < total) {
      if (out.gone()) {
        entry.outcome = "aborted";
        logLine(h, `pull of ${name} cancelled by the client`, "WARN");
        return;
      }
      const sc = h.scenario.pull;
      // the failures happen mid-stream, after some progress, which is what the dashboard has to cope with
      if (progressSent > 0 && sc === "fail") {
        entry.outcome = "failed";
        logLine(h, `pull of ${name} failed`, "ERROR");
        out.send({ error: "simulated failure: max retries exceeded: EOF" });
        out.end();
        return;
      }
      if (progressSent > 0 && sc === "drop") {
        entry.outcome = "dropped";
        res.destroy();
        return;
      }
      if (sc !== "stall" || progressSent === 0) {
        completed = Math.min(total, completed + Math.ceil(total / ((h.pullSeconds * 1000) / TICK)));
        h.partial.set(name, completed);
        entry.completed = completed;
        if (stream) out.send({ status: `pulling ${digest.slice(7, 19)}`, digest, total, completed });
        progressSent++;
      }
      if (completed < total) await sleep(TICK);
    }
    for (const status of ["verifying sha256 digest", "writing manifest"]) if (stream) out.send({ status });
    h.partial.delete(name);
    h.models.set(name, { ...(h.models.get(name) ?? makeModel(name)), modified_at: new Date().toISOString() });
    entry.outcome = "success";
    logLine(h, `pulled ${name}`);
    out.send({ status: "success" });
    out.end();
  } finally {
    h.activePulls--;
  }
}

async function create(h, body, res) {
  const name = fullName(String(body.model ?? ""));
  const out = ndjson(res);
  const from = h.models.get(fullName(String(body.from ?? "")));
  if (!from) {
    out.send({ error: `model '${body.from}' not found` });
    return out.end();
  }
  out.send({ status: `using existing layer sha256:${from.digest}` });
  while (h.scenario.create === "stall" && !out.gone()) await sleep(200);
  if (out.gone()) return;
  if (h.scenario.create === "fail") {
    out.send({ error: "simulated failure: creating model" });
    return out.end();
  }
  const params = Object.entries(body.parameters ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k} ${JSON.stringify(x)}`));
  out.send({ status: "creating new layer sha256:" + hash(name + JSON.stringify(body.parameters ?? {})) });
  out.send({ status: "writing manifest" });
  h.models.set(name, {
    ...from, name, model: name, digest: hash(name + Date.now()), modified_at: new Date().toISOString(),
    parameters: params.length ? params.join("\n") : from.parameters,
    system: typeof body.system === "string" ? body.system : from.system,
    details: { ...from.details, parent_model: from.name },
  });
  logLine(h, `created ${name} from ${from.name}`);
  out.send({ status: "success" });
  out.end();
}

async function generate(h, body, res) {
  const m = needModel(h, body.model);
  const ka = keepAliveMs(body.keep_alive, h.env.OLLAMA_KEEP_ALIVE);
  const base = { model: m.name, created_at: new Date().toISOString(), response: "", done: true };
  if (ka === 0) {
    h.loaded.delete(m.name);
    logLine(h, `unloaded ${m.name}`);
    return sendJson(res, 200, { ...base, done_reason: "unload" });
  }
  if (!h.loaded.has(m.name)) {
    await sleep(300);
    logLine(h, `loaded ${m.name}`);
  }
  h.loaded.set(m.name, { until: Date.now() + ka, ctx: Number(body.options?.num_ctx) || 4096 });
  if (!body.prompt) return sendJson(res, 200, { ...base, done_reason: "load" });
  const text = "This is a simulated response from llama-paddock's test host.";
  if (body.stream === false) return sendJson(res, 200, { ...base, response: text, done_reason: "stop", eval_count: 12 });
  const out = ndjson(res);
  for (const word of text.split(/(?= )/)) {
    out.send({ model: m.name, created_at: new Date().toISOString(), response: word, done: false });
    await sleep(30);
  }
  out.send({ ...base, done_reason: "stop", eval_count: 12 });
  out.end();
}

const ollamaRoutes = {
  "GET /": (h, req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Ollama is running");
  },
  "GET /api/version": (h) => ({ version: h.ollamaVersion }),
  "GET /api/tags": (h) => ({ models: [...h.models.values()].map(tagView) }),
  "GET /api/ps": (h) => ({ models: psModels(h) }),
  "POST /api/show": async (h, req) => {
    const body = await readBody(req);
    const m = needModel(h, body.model ?? body.name);
    return {
      modelfile: `FROM ${m.name}\n`,
      parameters: m.parameters,
      template: m.template,
      ...(m.system ? { system: m.system } : {}),
      details: m.details,
      model_info: { "general.architecture": m.arch, "general.parameter_count": m.params, [`${m.arch}.context_length`]: m.ctx },
      capabilities: m.capabilities,
      modified_at: m.modified_at,
    };
  },
  "POST /api/pull": async (h, req, res) => pull(h, await readBody(req), res),
  "POST /api/create": async (h, req, res) => create(h, await readBody(req), res),
  "POST /api/generate": async (h, req, res) => generate(h, await readBody(req), res),
  "DELETE /api/delete": async (h, req) => {
    const m = needModel(h, (await readBody(req)).model);
    h.models.delete(m.name);
    h.loaded.delete(m.name);
    logLine(h, `deleted ${m.name}`);
    return null;
  },
  "POST /api/copy": async (h, req) => {
    const body = await readBody(req);
    const m = needModel(h, body.source);
    const dest = fullName(String(body.destination ?? ""));
    h.models.set(dest, { ...m, name: dest, model: dest, modified_at: new Date().toISOString() });
    return null;
  },
};

function ollamaAuthorized(h, req) {
  if (!h.ollamaKey) return true;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return !!m && m[1].trim() === h.ollamaKey;
}

async function handleOllama(h, req, res) {
  const url = new URL(req.url, "http://ollama");
  const key = `${req.method} ${url.pathname}`;
  h.requests[`ollama ${key}`] = (h.requests[`ollama ${key}`] ?? 0) + 1;
  if (h.scenario.ollama === "hang") return void h.hung.add(res);
  if (h.scenario.ollama === "error") return sendJson(res, 500, { error: "simulated internal server error" });
  // like a reverse proxy in front of Ollama: plain 401, before Ollama sees the request
  if (!ollamaAuthorized(h, req)) {
    res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
    return res.end("401 Unauthorized");
  }
  const route = ollamaRoutes[key];
  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("404 page not found");
  }
  try {
    const result = await route(h, req, res);
    if (!res.headersSent && !res.writableEnded) {
      if (result === null) {
        res.writeHead(200);
        res.end();
      } else sendJson(res, 200, result);
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status ?? 500, { error: e.message });
    else res.destroy();
  }
}

// ------------------------------------------------------------------ agent API
/** Smooth, changing values from the clock, so charts move without any state to keep. */
const wave = (t, period, phase = 0) => (Math.sin((t / period + phase) * 2 * Math.PI) + 1) / 2;

function agentStats(h) {
  const t = Date.now() / 1000;
  const ollamaUp = h.scenario.ollama !== "down";
  const ps = ollamaUp ? psModels(h) : [];
  const busy = ps.length > 0;
  const vramPerGpu = h.gpus.length ? ps.reduce((s, m) => s + m.size_vram, 0) / h.gpus.length / MiB : 0;
  const gpus = h.gpus.map((g) => {
    const util = busy ? Math.round(20 + 75 * wave(t, 23, g.index * 0.3 + h.n * 0.17)) : Math.round(3 * wave(t, 7, g.index));
    return {
      index: g.index, uuid: g.uuid, name: GPU_MODEL.name, driver: "570.124.06", pstate: busy ? "P2" : "P8",
      temp_c: Math.round(34 + util * 0.42), fan_pct: Math.round(30 + util * 0.5), util_pct: util,
      mem_util_pct: busy ? Math.round(util * 0.6) : 0,
      mem_used_mib: Math.round(Math.min(GPU_MODEL.mem, 310 + vramPerGpu)), mem_total_mib: GPU_MODEL.mem,
      power_w: Math.round((22 + util * 3.1) * 100) / 100, power_limit_w: GPU_MODEL.power,
      sm_clock_mhz: busy ? Math.round(1600 + 300 * wave(t, 11, g.index)) : 210, sm_clock_max_mhz: GPU_MODEL.smMax,
      mem_clock_mhz: busy ? 9751 : 405, pcie_gen: busy ? 4 : 1, pcie_width: 16,
    };
  });
  const processes = ps.length ? h.gpus.map((g) => ({ gpu_uuid: g.uuid, pid: h.pid + 1, name: "/usr/local/bin/ollama", mem_mib: Math.round(vramPerGpu) })) : [];
  const cores = 16;
  const cpu = Math.round((4 + 30 * wave(t, 41, h.n * 0.21) + (busy ? 10 : 0)) * 10) / 10;
  const memTotal = 64 * GiB;
  const memUsed = Math.round(6 * GiB + ps.reduce((s, m) => s + (m.size - m.size_vram), 0) + 0.5 * GiB * wave(t, 60));
  const diskTotal = 500 * GiB;
  const diskUsed = 40 * GiB + [...h.models.values()].reduce((s, m) => s + m.size, 0) + [...h.partial.values()].reduce((s, b) => s + b, 0);
  const service = ollamaUp
    ? { active: "active", sub: "running", since: new Date(h.startedAt).toUTCString(), main_pid: h.pid, restarts: String(h.restarts) }
    : { active: "failed", sub: "failed", since: new Date(h.startedAt).toUTCString(), main_pid: null, restarts: String(h.restarts) };
  return {
    ts: t,
    ...(h.agentVersion ? { version: h.agentVersion } : {}),
    platform: "linux",
    system: {
      hostname: h.hostname,
      uptime_s: Math.round(86400 * 3 + (Date.now() - h.startedAt) / 1000),
      cpu_count: cores,
      cpu_pct: cpu,
      cpu_per_core: Array.from({ length: cores }, (_, i) => Math.round(Math.min(100, cpu * (0.4 + 1.2 * wave(t, 13, i / cores))) * 10) / 10),
      load: [cpu / 100 * cores, cpu / 100 * cores * 0.9, cpu / 100 * cores * 0.8].map((x) => Math.round(x * 100) / 100),
      mem: { total: memTotal, used: memUsed, available: memTotal - memUsed, pct: Math.round((memUsed / memTotal) * 1000) / 10 },
      swap: { total: 8 * GiB, used: 0, pct: 0 },
      disks: [{ path: "/", total: diskTotal, used: diskUsed, free: diskTotal - diskUsed, pct: Math.round((diskUsed / diskTotal) * 1000) / 10 }],
      // a pull downloads at ~100 MB/s
      net: { rx_bps: Math.round(2e4 + 5e4 * wave(t, 17) + h.activePulls * 1e8), tx_bps: Math.round(1e4 + 3e4 * wave(t, 19)) },
      ollama_process: ollamaUp ? { pid: h.pid, rss_total: 450 * MiB + ps.reduce((s, m) => s + (m.size - m.size_vram), 0), runners: ps.length } : null,
    },
    nvidia: h.gpus.length ? { available: true, gpus, processes } : { available: false, error: "nvidia-smi not found", gpus: [], processes: [] },
    service,
  };
}

function quoteEnv(k, v) {
  return `Environment="${`${k}=${v}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}
const renderOverride = (env) => ["[Service]", ...Object.entries(env).map(([k, v]) => quoteEnv(k, v))].join("\n") + "\n";
const BASE_UNIT_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };

async function restartOllama(h) {
  logLine(h, "Stopping ollama.service...");
  h.restarts++;
  h.loaded.clear();
  // a restart brings a crashed Ollama back, like systemctl restart would
  await setOllama(h, "down");
  await sleep(500);
  h.startedAt = Date.now();
  await setOllama(h, "up");
  logLine(h, `Listening on [::]:11434 (version ${h.ollamaVersion})`);
  return { ok: true, stderr: "" };
}

const agentRoutes = {
  "GET /health": (h) => ({ ok: true, version: h.agentVersion ?? undefined, platform: "linux", hostname: h.hostname }),
  "GET /stats": (h) => agentStats(h),
  "GET /env": (h) => ({
    managed: { ...h.env }, override_path: OVERRIDE_PATH, raw: renderOverride(h.env), allowed: AGENT_ENV_ALLOW,
    platform: "linux", effective: { ...BASE_UNIT_ENV, ...h.env }, external: { ...BASE_UNIT_ENV },
  }),
  // same validation as the agents' putEnv()
  "PUT /env": async (h, req) => {
    const body = await readBody(req);
    const vars = body?.vars;
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw new HttpErr(400, "body must be {vars: {...}, restart?: bool}");
    for (const [k, v] of Object.entries(vars)) {
      if (!KEY_RE.test(k)) throw new HttpErr(400, `invalid variable name: ${JSON.stringify(k)}`);
      if (typeof v !== "string") throw new HttpErr(400, `value of ${k} must be a string`);
      if (/[\r\n]/.test(v)) throw new HttpErr(400, `newlines not allowed in value of ${k}`);
      if (!envAllowed(k) && h.env[k] !== v) {
        throw new HttpErr(400, `${k} is not an Ollama variable; add it to PADDOCK_AGENT_ENV_ALLOW on the host to manage it here`);
      }
    }
    const kept = Object.fromEntries(Object.entries(h.env).filter(([k]) => !envAllowed(k)));
    h.env = { ...kept, ...vars };
    const result = { written: OVERRIDE_PATH, content: renderOverride(h.env) };
    if (body.restart !== false) result.restart = await restartOllama(h);
    return result;
  },
  "POST /service/restart": (h) => restartOllama(h),
  "GET /logs": (h, _req, url) => {
    const lines = Math.max(10, Math.min(Number(url.searchParams.get("lines")) || 200, 2000));
    return { lines: h.log.slice(-lines) };
  },
};

function agentAuthorized(h, req) {
  if (h.scenario.agent === "bad-token") return false;
  const a = req.headers.authorization ?? "";
  const supplied = Buffer.from(a.toLowerCase().startsWith("bearer ") ? a.slice(7) : "");
  const expected = Buffer.from(h.agentToken);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function handleAgent(h, req, res) {
  const url = new URL(req.url, "http://agent");
  const key = `${req.method} ${url.pathname}`;
  h.requests[`agent ${key}`] = (h.requests[`agent ${key}`] ?? 0) + 1;
  if (h.scenario.agent === "hang") return void h.hung.add(res);
  if (h.scenario.agent === "error") return sendJson(res, 500, { detail: "simulated agent failure" });
  const route = agentRoutes[key];
  if (!route) return sendJson(res, 404, { detail: "not found" });
  if (url.pathname !== "/health" && !agentAuthorized(h, req)) return sendJson(res, 401, { detail: "invalid agent token" });
  try {
    sendJson(res, 200, await route(h, req, url));
  } catch (e) {
    sendJson(res, e.status ?? 500, { detail: e.message });
  }
}

// ------------------------------------------------------------------ servers and scenarios
let opts;
const hosts = new Map();

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once("error", onError);
    server.listen(port, opts.bind, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function stopListening(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    // "down" means down: cut open connections too, including streams in progress
    server.closeAllConnections();
  });
}

/** Answer requests left hanging, by cutting them off, when a "hang" scenario ends. */
function releaseHung(h) {
  for (const res of h.hung) res.destroy();
  h.hung.clear();
}

async function setOllama(h, state) {
  h.scenario.ollama = state;
  if (state !== "hang") releaseHung(h);
  const s = h.servers.ollama;
  if (state === "down") await stopListening(s);
  else if (!s.listening) await listen(s, h.ollamaPort);
}

async function setAgent(h, state) {
  h.scenario.agent = state;
  if (state !== "hang") releaseHung(h);
  const s = h.servers.agent;
  if (state === "down") await stopListening(s);
  else if (!s.listening) await listen(s, h.agentPort);
}

async function applyScenario(h, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpErr(400, "body must be a JSON object");
  const known = [...Object.keys(SCENARIO_VALUES), "pull_seconds", "ollama_key", "agent_token", "ollama_version", "agent_version"];
  for (const [k, v] of Object.entries(patch)) {
    if (!known.includes(k)) throw new HttpErr(400, `unknown field ${k}; known: ${known.join(", ")}`);
    if (SCENARIO_VALUES[k] && !SCENARIO_VALUES[k].includes(v)) throw new HttpErr(400, `${k} must be one of ${SCENARIO_VALUES[k].join(", ")}`);
  }
  if (patch.pull_seconds !== undefined) {
    if (!(Number(patch.pull_seconds) > 0)) throw new HttpErr(400, "pull_seconds must be a positive number");
    h.pullSeconds = Number(patch.pull_seconds);
  }
  if (patch.ollama_key !== undefined) h.ollamaKey = patch.ollama_key ? String(patch.ollama_key) : null;
  if (patch.agent_token !== undefined) {
    if (!patch.agent_token) throw new HttpErr(400, "agent_token can't be empty: the agents refuse to start without one");
    h.agentToken = String(patch.agent_token);
  }
  if (patch.ollama_version !== undefined) h.ollamaVersion = String(patch.ollama_version);
  if (patch.agent_version !== undefined) h.agentVersion = patch.agent_version ? String(patch.agent_version) : null;
  if (patch.pull) h.scenario.pull = patch.pull;
  if (patch.create) h.scenario.create = patch.create;
  if (patch.ollama) await setOllama(h, patch.ollama);
  if (patch.agent) await setAgent(h, patch.agent);
  console.log(`paddock-sim: ${h.id} ${JSON.stringify(patch)}`);
  return hostView(h, true);
}

function hostView(h, full = false) {
  const base = `http://${opts.bind === "0.0.0.0" ? "127.0.0.1" : opts.bind}`;
  const view = {
    id: h.id,
    hostname: h.hostname,
    ollama_url: `${base}:${h.ollamaPort}`,
    agent_url: `${base}:${h.agentPort}`,
    agent_token: h.agentToken,
    ollama_key: h.ollamaKey,
    gpus: h.gpus.length,
    pull_seconds: h.pullSeconds,
    ollama_version: h.ollamaVersion,
    agent_version: h.agentVersion,
    scenario: { ...h.scenario },
  };
  if (!full) return view;
  return {
    ...view,
    models: [...h.models.keys()],
    loaded: psModels(h).map((m) => m.name),
    partial: Object.fromEntries(h.partial),
    pulls: h.pulls,
    restarts: h.restarts,
    requests: h.requests,
  };
}

function configYaml() {
  const lines = [
    "# Generated by test/sim/paddock-sim.mjs for its simulated hosts.",
    "poll_interval: 2",
    "metrics_open: true",
    "instances:",
  ];
  for (const h of hosts.values()) {
    const v = hostView(h);
    lines.push(`  - id: ${h.id}`, `    name: ${h.id}`, `    ollama_url: ${v.ollama_url}`);
    if (h.ollamaKey) lines.push(`    ollama_api_key: ${JSON.stringify(h.ollamaKey)}`);
    lines.push(`    agent_url: ${v.agent_url}`, `    agent_token: ${JSON.stringify(h.agentToken)}`, "    tags: [sim]");
  }
  return lines.join("\n") + "\n";
}

async function handleControl(req, res) {
  const url = new URL(req.url, "http://control");
  try {
    if (req.method === "GET" && (url.pathname === "/_sim" || url.pathname === "/_sim/hosts")) {
      return sendJson(res, 200, { hosts: [...hosts.values()].map((h) => hostView(h)) });
    }
    if (req.method === "GET" && url.pathname === "/_sim/config.yaml") {
      res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
      return res.end(configYaml());
    }
    const m = /^\/_sim\/hosts\/([^/]+)(\/scenario)?$/.exec(url.pathname);
    const h = m && hosts.get(decodeURIComponent(m[1]));
    if (m && !h) throw new HttpErr(404, `no host ${m[1]}`);
    if (h && !m[2] && req.method === "GET") return sendJson(res, 200, hostView(h, true));
    if (h && m[2] && req.method === "POST") return sendJson(res, 200, await applyScenario(h, await readBody(req)));
    sendJson(res, 404, { detail: "not found; see the header of test/sim/paddock-sim.mjs" });
  } catch (e) {
    sendJson(res, e.status ?? 500, { detail: e.message });
  }
}

async function main() {
  opts = options(process.argv.slice(2));
  for (let n = 1; n <= opts.hosts; n++) hosts.set(`sim-${n}`, makeHost(n, opts));

  const control = http.createServer(handleControl);
  try {
    await listen(control, opts.basePort);
    for (const h of hosts.values()) {
      h.servers.ollama = http.createServer((req, res) => void handleOllama(h, req, res));
      h.servers.agent = http.createServer((req, res) => void handleAgent(h, req, res));
      await listen(h.servers.ollama, h.ollamaPort);
      await listen(h.servers.agent, h.agentPort);
    }
  } catch (e) {
    fail(`can't listen: ${e.message}`);
  }

  if (opts.writeConfig) {
    fs.writeFileSync(opts.writeConfig, configYaml(), { mode: 0o600 });
    console.log(`paddock-sim: wrote ${opts.writeConfig}`);
  }
  console.log(`paddock-sim: control API on http://${opts.bind}:${opts.basePort}/_sim/hosts`);
  for (const h of hosts.values()) {
    const v = hostView(h);
    console.log(`paddock-sim: ${h.id}  Ollama ${v.ollama_url}${h.ollamaKey ? " (API key)" : ""}  agent ${v.agent_url}  ${h.gpus.length} GPU(s)`);
  }

  const shutdown = () => {
    control.close();
    control.closeAllConnections();
    for (const h of hosts.values()) {
      releaseHung(h);
      for (const s of Object.values(h.servers)) {
        s.close();
        s.closeAllConnections();
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
