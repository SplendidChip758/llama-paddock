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
 * agent API of the Linux agent (SplendidChip758/llama-paddock-agent; /health, /stats, /env, /logs,
 * /service/restart, /gpu-check, /gpu/reload-uvm, /runner-starts, /update, with the same bearer-token rule). Like the agents, the agent
 * port serves HTTPS with a self-signed certificate (a new key per host and run)
 * and plain HTTP. A third port serves the control API, which switches failure
 * scenarios at runtime.
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
 *   --ollama-key LIST    answer 401 without this key, like an authenticating proxy in front of
 *                        Ollama (Ollama has no keys itself): one key for all hosts, or per host
 *                        ("key1,,key3"; empty = no key). Default: none
 *   --pull-seconds S     how long a full model pull takes (default 8)
 *   --write-config FILE  write a dashboard config.yaml for these hosts and keep running
 *   --help
 *
 * Model registry, on the control port: GET /_sim/registry/v2/<repo>/manifests/<tag> and its blobs,
 * like registry.ollama.ai (point the dashboard's model_registry_url at http://<bind>:<B>/_sim/registry),
 * and ollama.com's library pages: GET /_sim/ollama.com/search and /_sim/ollama.com/<path>/tags
 * (model_library_url: http://<bind>:<B>/_sim/ollama.com). GET /_sim/library-requests lists the
 * pages asked for, and the reads of model weights from the registry ("weights <model> <range>").
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
 *        ollama_version, agent_version (null: /stats leaves the version out, like agents before 0.6.0;
 *                     below 0.8.0 there is no /gpu-check, /gpu/reload-uvm or /runner-starts either, as in those agents)
 *        agent_protocol: the agent protocol /health and /stats report (default: the one the agent in
 *                     test/agent-release speaks; null: left out, like agents before 0.10.0)
 *        agent_http:  false = HTTPS only (PADDOCK_AGENT_HTTP=off), true = both (default)
 *        agent_tls:   false = no HTTPS and no fingerprint, like agents before 0.7.0
 *        agent_key:   "new" = replace the agent's key, as the installer's PADDOCK_AGENT_NEW_KEY does
 *        ps_size_vram: false = leave size_vram out of /api/ps, so the dashboard can't tell the split
 *        gpu_temp:    °C every GPU reports instead of the simulated curve (null: back to the curve)
 *        vram_pct:    share of each GPU's memory in use, 0-100 (null: what the loaded models take)
 *        disk_pct:    how full the root filesystem is, 0-100 (null: what the models take)
 *        models_disk_pct:  report OLLAMA_MODELS (or /srv/ollama/models) as a filesystem of its own,
 *                     this full (null: no separate filesystem, as before)
 *        crash:       "ollama" = Ollama's process dies and systemd starts a new one (new pid, models
 *                     unloaded); "runner" = the runner of the first loaded model exits while
 *                     /api/ps still lists the model, until it's loaded or unloaded again
 *        gpu_lost:    Ollama loses the GPU, as after a suspend and resume: it logs CUDA error 999, and
 *                     loaded and newly loaded models run on the CPU while nvidia-smi still sees the
 *                     GPUs. The value is what brings the GPU back: "restart" (restarting Ollama) or
 *                     "uvm" (only POST /gpu/reload-uvm). false: the GPU is back at once
 *        agent_update: what POST /update does: "normal" (the agent restarts as the newest simulated
 *                     release on the asked channel, or stays as it is when it already runs that),
 *                     "fail" (the updater fails and the agent keeps its version), "none" (an agent
 *                     without /update or self_update, like one from before 0.10.0)
 *
 * Agent releases, on the control port, like GitHub's API (agent_releases_url: http://<bind>:<B>/_sim/github):
 *   GET  /_sim/github/repos/<owner>/<repo>/releases   the simulated releases; a repo ending in
 *                                       -win-agent is the Windows agent's, any other the Linux agent's
 *   POST /_sim/github/releases          {linux?: [tags], windows?: [tags]}: replace them. Tags with a
 *                                       "-" are prereleases. Default: the version the hosts' agents run
 *   GET  /_sim/github/requests          how many times the releases were read
 *
 * Models: loading with a num_ctx whose KV cache doesn't fit in the GPUs puts the rest in system RAM
 * (a partial GPU/CPU split), as does a host without GPUs or num_gpu 0 in the request's options or the
 * Modelfile (all on the CPU). A load's context is options.num_ctx, else num_ctx in the Modelfile, else
 * OLLAMA_CONTEXT_LENGTH, else 4096; a new one reloads the model. Every load logs "llama runner started", and
 * a prompt with keep_alive 0 loads, answers and unloads within the request, so no poll sees it loaded.
 * Pulling a name ending in "-cloud" or ":cloud" adds an Ollama cloud model: listed with
 * remote_host/remote_model, answering /api/generate, but never in /api/ps since it runs remotely.
 * /api/generate and /api/chat stream a canned answer a word at a time, sim-1 fastest and each later
 * host slower, and end with Ollama's timing stats (load, prompt and eval counts and durations).
 *   GET  /_sim/config.yaml              the same config.yaml as --write-config
 *
 * Request log: the simulated Ollama records each request it answers, as Ollama's log would (time,
 * status, duration, client, method, path), and the agent serves them on GET /requests?since=…
 * A request with an X-Sim-Client header is recorded as coming from that address, so tests can
 * play several client machines from one.
 *
 * Webhook receiver, for the dashboard's notification channels (any name; point a Webhook, Discord
 * or Slack channel at http://<bind>:<base-port>/_sim/webhook/<name>):
 *   POST   /_sim/webhook/<name>         records the message (and logs its summary); 204
 *   GET    /_sim/webhook/<name>         {received: [{t, headers, body}]}
 *   POST   /_sim/webhook/<name>/fail    {status, times = 1, retry_after?}: answer the next `times`
 *                                       messages with that status (and a Retry-After header)
 *   DELETE /_sim/webhook/<name>         forget what was received and any failures still set
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { agentSource } from "../agent.mjs";

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
/** The protocol of the agent the tests run against (test/agent.mjs), so the simulated agent matches it by default. */
function repoAgentProtocol() {
  return Number(/const PROTOCOL = (\d+);/.exec(agentSource() ?? "")?.[1] ?? 1);
}

function repoAgentVersion() {
  return /const VERSION = "([^"]+)"/.exec(agentSource() ?? "")?.[1] ?? "0.0.0-sim";
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

const CLOUD_NAME = /[:-]cloud$/;

/** A model as /api/tags would list it, made up from its name. */
function makeModel(name, extra = {}) {
  name = fullName(name);
  // a cloud model is a small stub pointing at the remote model; its size is the stub's
  const cloud = CLOUD_NAME.test(name) ? { remote_model: name.replace(CLOUD_NAME, "").replace(/:$/, ""), remote_host: "https://ollama.com:443", size: 384 } : {};
  const f = FAMILIES.find((x) => x.match.test(name));
  const params = Number(/(\d+(?:\.\d+)?)b\b/i.exec(name)?.[1] ?? (1 + unit(name) * 7).toFixed(1));
  // bytes per parameter of the quantization the tag names; Q4_K_M when it names none
  const quant = /(q8_0|fp16|bf16)$/i.exec(name)?.[1].toLowerCase();
  const perParam = { q8_0: 1.07, fp16: 2, bf16: 2 }[quant] ?? 0.6;
  return {
    name,
    model: name,
    modified_at: new Date().toISOString(),
    // roughly a Q4_K_M file: ~0.6 bytes per parameter
    size: Math.round(params * 1e9 * perParam + unit(name + "s") * 2e8),
    digest: hash(name),
    details: {
      parent_model: "", format: "gguf", family: f.family, families: [f.family],
      parameter_size: `${params}B`, quantization_level: { q8_0: "Q8_0", fp16: "F16", bf16: "BF16" }[quant] ?? "Q4_K_M",
    },
    arch: f.arch,
    ctx: f.ctx,
    capabilities: f.caps,
    parameters: 'stop "<|eot_id|>"\ntemperature 0.7',
    template: "{{ .System }}\n{{ .Prompt }}",
    system: null,
    params: params * 1e9,
    ...cloud,
    ...extra,
  };
}

/**
 * The shape behind the KV cache the simulator charges: 32 layers × 8 KV heads × (128 + 128) × 2 bytes
 * = 128 KiB per token. /api/show and the registry's GGUF headers both report it.
 */
const ARCH_INFO = { block_count: 32, embedding_length: 4096, "attention.head_count": 32, "attention.head_count_kv": 8, vocab_size: 128256 };
const modelInfo = (m) => ({
  "general.architecture": m.arch, "general.parameter_count": m.params, [`${m.arch}.context_length`]: m.ctx,
  ...Object.fromEntries(Object.entries(ARCH_INFO).map(([k, v]) => [`${m.arch}.${k}`, v])),
});

const tagView = (m) => ({
  name: m.name, model: m.model, ...(m.remote_host ? { remote_model: m.remote_model, remote_host: m.remote_host } : {}),
  modified_at: m.modified_at, size: m.size, digest: m.digest, details: m.details,
});

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
  agent_update: ["normal", "fail", "none"],
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
    agentProtocol: repoAgentProtocol(),
    pullSeconds: o.pullSeconds,
    /** milliseconds per streamed token, so hosts compare differently side by side */
    tokenMs: 20 + 10 * (n - 1),
    scenario: { ollama: "up", agent: "up", pull: "normal", create: "normal", agent_update: "normal" },
    /** the updater's last run, as the agent's GET /update reports it */
    update: { state: "idle" },
    gpus: Array.from({ length: o.gpus[n - 1] }, (_, i) => ({
      index: i, uuid: `GPU-${hash(`${id}/${i}`).slice(0, 8)}-${hash(`${id}/${i}`).slice(8, 12)}-sim0-${hash(`${id}/${i}`).slice(12, 24)}`,
    })),
    models: new Map(SEED_MODELS.map((name) => [name, makeModel(name)])),
    /** blobs pushed to /api/blobs: digest → { size } */
    blobs: new Map(),
    /** name → { until: ms timestamp or Infinity, ctx, cpuOnly: options.num_gpu was 0 } */
    loaded: new Map(),
    /** model → bytes already downloaded, so a pull that was cut off resumes (Ollama keeps partial blobs) */
    partial: new Map(),
    env: { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_KEEP_ALIVE: "5m" },
    log: [],
    /** the log since Ollama last started, as the agent's /gpu-check reads it from the journal */
    runLog: [],
    pulls: [],
    activePulls: 0,
    requests: {},
    /** what Ollama's log would say about each request it answered: {t, status, duration_ms, client, method, path} */
    requestLog: [],
    /** streamed answers that stopped early because the client hung up */
    answersStopped: 0,
    restarts: 0,
    startedAt: Date.now(),
    pid: 1000 + n * 37,
    hung: new Set(),
    servers: {},
    agentTls: true,
    agentHttp: true,
    psSizeVram: true,
    /** runtime-switchable readings for the alert scenarios; null = simulated */
    gpuTemp: null,
    vramPct: null,
    diskPct: null,
    modelsDiskPct: null,
    /** loaded models whose runner process has exited */
    deadRunners: new Set(),
    /** false, or what brings the GPU back: "restart" or "uvm" */
    gpuLost: false,
  };
  // the first host has something loaded, so the dashboard shows VRAM in use right away
  if (n === 1) h.loaded.set("llama3.2:3b", { until: Infinity, ctx: 4096 });
  ollamaStarted(h);
  return h;
}

function logLine(h, msg, level = "INFO", attrs = "") {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "+0000");
  const line = `${ts} ${h.hostname} ollama[${h.pid}]: time=${new Date().toISOString()} level=${level} msg="${msg.replace(/"/g, "'")}"${attrs}`;
  for (const log of [h.log, h.runLog]) {
    log.push(line);
    if (log.length > 2000) log.splice(0, log.length - 2000);
  }
}

/** What Ollama logs when it starts, including its GPU discovery (in the wording of Ollama 0.12). */
function ollamaStarted(h) {
  h.runLog = [];
  logLine(h, `Listening on [::]:11434 (version ${h.ollamaVersion})`);
  if (h.gpuLost || !h.gpus.length) {
    logLine(h, "no compatible GPUs were discovered");
    logLine(h, "inference compute", "INFO", ' id=cpu library=cpu compute="" name=cpu description=cpu total="62.7 GiB" available="58.1 GiB"');
    return;
  }
  for (const g of h.gpus) {
    logLine(h, "inference compute", "INFO", ` id=${g.uuid} library=CUDA compute=8.6 name=CUDA${g.index} description="${GPU_MODEL.name}" driver=12.8 total="24.0 GiB" available="23.5 GiB"`);
  }
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
      h.deadRunners.delete(name);
      continue;
    }
    // file size plus KV cache for the context; spills into system RAM once the GPUs are full
    const size = m.size + l.ctx * 128 * 1024;
    const size_vram = l.cpuOnly || h.gpuLost ? 0 : Math.max(0, Math.min(size, vramFree));
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

/** Ollama's blob upload: HEAD says whether it has the blob, POST stores it if the body's sha256 matches. */
async function blobRoute(h, req, res, digest) {
  if (req.method === "HEAD") {
    res.writeHead(h.blobs.has(digest) ? 200 : 404);
    return res.end();
  }
  const sha = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of req) {
    sha.update(chunk);
    size += chunk.length;
  }
  if (`sha256:${sha.digest("hex")}` !== digest) return sendJson(res, 400, { error: "digest mismatch" });
  h.blobs.set(digest, { size });
  logLine(h, `received blob ${digest} (${size} bytes)`);
  res.writeHead(201);
  res.end();
}

async function create(h, body, res) {
  const name = fullName(String(body.model ?? ""));
  const out = ndjson(res);
  let from;
  if (body.files && typeof body.files === "object") {
    // a model from an uploaded GGUF: its size is the blob's
    const [, digest] = Object.entries(body.files)[0] ?? [];
    const blob = h.blobs.get(String(digest));
    if (!blob) {
      out.send({ error: `blob ${digest} not found` });
      return out.end();
    }
    from = { ...makeModel(name), size: blob.size, parameters: "", template: "{{ .Prompt }}" };
  } else {
    from = h.models.get(fullName(String(body.from ?? "")));
  }
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
    template: typeof body.template === "string" ? body.template : from.template,
    details: { ...from.details, parent_model: body.files ? "" : from.name },
  });
  logLine(h, `created ${name} from ${body.files ? "an uploaded file" : from.name}`);
  out.send({ status: "success" });
  out.end();
}

const ANSWER = "This is a simulated response from llama-paddock's test host.";
const ns = (ms) => Math.round(ms * 1e6);

/** /api/generate and /api/chat: load the model if needed, then answer. `prompt` is the text to evaluate, if any. */
async function answer(h, body, res, prompt, chat) {
  const m = needModel(h, body.model);
  const ka = keepAliveMs(body.keep_alive, h.env.OLLAMA_KEEP_ALIVE);
  const started = performance.now();
  const base = { model: m.name, created_at: new Date().toISOString(), ...(chat ? { message: { role: "assistant", content: "" } } : { response: "" }), done: true };
  // a new load (or unload) replaces a runner that exited
  h.deadRunners.delete(m.name);
  if (ka === 0 && !prompt) {
    h.loaded.delete(m.name);
    logLine(h, `unloaded ${m.name}`);
    return sendJson(res, 200, { ...base, done_reason: "unload" });
  }
  const cpuOnly = body.options?.num_gpu === 0 || /^num_gpu\s+"?0"?$/m.test(m.parameters ?? "");
  const ctx = Number(body.options?.num_ctx) || Number(/^num_ctx\s+"?(\d+)"?$/m.exec(m.parameters ?? "")?.[1]) ||
    Number(h.env.OLLAMA_CONTEXT_LENGTH) || 4096;
  let loadMs = 0;
  // cloud models run remotely: Ollama forwards the request and loads nothing
  if (!m.remote_host && h.loaded.get(m.name)?.ctx !== ctx) {
    h.loaded.delete(m.name);
    await sleep(300);
    loadMs = 300;
    if (cpuOnly || h.gpuLost || !h.gpus.length) logLine(h, "load_tensors: offloaded 0/29 layers to GPU");
    logLine(h, "llama runner started in 0.30 seconds");
    logLine(h, `loaded ${m.name}`);
  }
  const words = ANSWER.split(/(?= )/);
  const promptTokens = prompt ? prompt.split(/\s+/).filter(Boolean).length + 8 : 0;
  const stats = (evalMs) => ({
    total_duration: ns(performance.now() - started), load_duration: ns(loadMs),
    prompt_eval_count: promptTokens, prompt_eval_duration: ns(promptTokens * 2),
    eval_count: words.length, eval_duration: ns(evalMs),
  });
  const text = (t) => (chat ? { message: { role: "assistant", content: t } } : { response: t });
  if (ka === 0) {
    // answered, then unloaded at once: only the log shows the load
    h.loaded.delete(m.name);
    logLine(h, `unloaded ${m.name}`);
    return sendJson(res, 200, { ...base, ...text(ANSWER), done_reason: "stop", ...stats(words.length * h.tokenMs) });
  }
  if (!m.remote_host) h.loaded.set(m.name, { until: Date.now() + ka, ctx, cpuOnly });
  if (!prompt) return sendJson(res, 200, { ...base, done_reason: "load", total_duration: ns(performance.now() - started), load_duration: ns(loadMs) });
  if (body.stream === false) return sendJson(res, 200, { ...base, ...text(ANSWER), done_reason: "stop", ...stats(words.length * h.tokenMs) });
  const out = ndjson(res);
  await sleep(promptTokens * 2);
  const evalStart = performance.now();
  for (const word of words) {
    if (out.gone()) return void h.answersStopped++;
    out.send({ model: m.name, created_at: new Date().toISOString(), ...text(word), done: false });
    await sleep(h.tokenMs);
  }
  out.send({ ...base, done_reason: "stop", ...stats(performance.now() - evalStart) });
  out.end();
}

const generate = (h, body, res) => answer(h, body, res, body.prompt ? String(body.prompt) : "", false);

function chat(h, body, res) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return answer(h, body, res, messages.map((x) => String(x?.content ?? "")).join(" "), true);
}

const ollamaRoutes = {
  "GET /": (h, req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Ollama is running");
  },
  "GET /api/version": (h) => ({ version: h.ollamaVersion }),
  "GET /api/tags": (h) => ({ models: [...h.models.values()].map(tagView) }),
  "GET /api/ps": (h) => ({ models: psModels(h).map(({ size_vram, ...m }) => (h.psSizeVram ? { ...m, size_vram } : m)) }),
  "POST /api/show": async (h, req) => {
    const body = await readBody(req);
    const m = needModel(h, body.model ?? body.name);
    return {
      modelfile: `FROM ${m.name}\n`,
      parameters: m.parameters,
      template: m.template,
      ...(m.system ? { system: m.system } : {}),
      details: m.details,
      model_info: modelInfo(m),
      capabilities: m.capabilities,
      modified_at: m.modified_at,
    };
  },
  "POST /api/pull": async (h, req, res) => pull(h, await readBody(req), res),
  "POST /api/create": async (h, req, res) => create(h, await readBody(req), res),
  "POST /api/generate": async (h, req, res) => generate(h, await readBody(req), res),
  "POST /api/chat": async (h, req, res) => chat(h, await readBody(req), res),
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
  // a plain prefix check, as the agents do: a regex over the header can backtrack on crafted input
  const a = req.headers.authorization ?? "";
  return a.toLowerCase().startsWith("bearer ") && a.slice(7).trim() === h.ollamaKey;
}

/** Requests the simulated log keeps per host. */
const REQUEST_LOG_MAX = 20_000;

async function handleOllama(h, req, res) {
  const url = new URL(req.url, "http://ollama");
  const key = `${req.method} ${url.pathname}`;
  h.requests[`ollama ${key}`] = (h.requests[`ollama ${key}`] ?? 0) + 1;
  const started = performance.now();
  const client = String(req.headers["x-sim-client"] || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  // logged when the answer is done, as gin does (a request cut off midway is still logged)
  res.once("close", () => {
    h.requestLog.push({
      t: Date.now() / 1000, status: res.statusCode, duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
      client, method: req.method, path: url.pathname,
    });
    if (h.requestLog.length > REQUEST_LOG_MAX) h.requestLog.splice(0, h.requestLog.length - REQUEST_LOG_MAX);
  });
  if (h.scenario.ollama === "hang") return void h.hung.add(res);
  if (h.scenario.ollama === "error") return sendJson(res, 500, { error: "simulated internal server error" });
  // like a reverse proxy in front of Ollama: plain 401, before Ollama sees the request
  if (!ollamaAuthorized(h, req)) {
    res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": "Bearer" });
    return res.end("401 Unauthorized");
  }
  const blob = /^\/api\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
  if (blob && (req.method === "HEAD" || req.method === "POST")) return blobRoute(h, req, res, blob[1]);
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

// ------------------------------------------------------------------ agent TLS
// The certificate writer of the agents' TLS section, copied: each host makes its key in memory.
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (; n; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, ...parts) {
  const body = Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p)));
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const derSeq = (...parts) => der(0x30, ...parts);
function derOid(dotted) {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (let v of rest) {
    const group = [v & 0x7f];
    while ((v >>= 7)) group.unshift((v & 0x7f) | 0x80);
    out.push(...group);
  }
  return der(0x06, Buffer.from(out));
}

function selfSignedCert(privateKey) {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40; // positive, and no leading zero byte
  const ecdsaSha256 = derSeq(derOid("1.2.840.10045.4.3.2"));
  const name = derSeq(der(0x31, derSeq(derOid("2.5.4.3"), der(0x0c, "llama-paddock-agent"))));
  const notBefore = new Date(Date.now() - 3600_000).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  const tbs = derSeq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    ecdsaSha256,
    name,
    // 9999-12-31: no expiry (RFC 5280, 4.1.2.5)
    derSeq(der(0x17, notBefore), der(0x18, "99991231235959Z")),
    name,
    crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }),
    der(0xa3, derSeq(derSeq(derOid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, derSeq())))), // CA: false
  );
  const cert = derSeq(tbs, ecdsaSha256, der(0x03, Buffer.from([0]), crypto.sign("sha256", tbs, privateKey)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** SHA256:<base64>, the same as `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`. */
const keyFingerprint = (publicKey) =>
  `SHA256:${crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64").replace(/=+$/, "")}`;

function newAgentKey(h) {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  h.tls = {
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
    cert: selfSignedCert(privateKey),
    fingerprint: keyFingerprint(crypto.createPublicKey(privateKey)),
  };
}

/** The agent port: HTTPS and plain HTTP on one port, told apart by the first byte as the agents do. */
function agentServer(h) {
  const onRequest = (req, res) => void handleAgent(h, req, res);
  const plain = http.createServer(onRequest);
  const secure = https.createServer({ key: h.tls.key, cert: h.tls.cert }, onRequest);
  // the servers behind it never listen themselves, so they don't track connections: do it here
  const sockets = new Set();
  const front = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.once("readable", () => {
      const head = socket.read(1);
      if (!head) return socket.destroy();
      socket.unshift(head);
      (head[0] === 0x16 && h.agentTls ? secure : plain).emit("connection", socket);
    });
  });
  // what stopListening() expects of an http.Server
  front.closeAllConnections = () => {
    for (const s of sockets) s.destroy();
  };
  front.useKey = () => secure.setSecureContext({ key: h.tls.key, cert: h.tls.cert });
  return front;
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
      temp_c: h.gpuTemp ?? Math.round(34 + util * 0.42), fan_pct: Math.round(30 + util * 0.5), util_pct: util,
      mem_util_pct: busy ? Math.round(util * 0.6) : 0,
      mem_used_mib: h.vramPct != null ? Math.round((GPU_MODEL.mem * h.vramPct) / 100) : Math.round(Math.min(GPU_MODEL.mem, 310 + vramPerGpu)),
      mem_total_mib: GPU_MODEL.mem,
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
  const modelBytes = [...h.models.values()].reduce((s, m) => s + (m.remote_host ? 0 : m.size), 0) + [...h.partial.values()].reduce((s, b) => s + b, 0);
  const disk = (path, total, used) => ({ path, total, used, free: total - used, pct: Math.round((used / total) * 1000) / 10 });
  const disks = [disk("/", diskTotal, h.diskPct != null ? Math.round((diskTotal * h.diskPct) / 100) : 40 * GiB + modelBytes)];
  if (h.modelsDiskPct != null) disks.push(disk(h.env.OLLAMA_MODELS || "/srv/ollama/models", 2000 * GiB, Math.round((2000 * GiB * h.modelsDiskPct) / 100)));
  const service = ollamaUp
    ? { active: "active", sub: "running", since: new Date(h.startedAt).toUTCString(), main_pid: h.pid, restarts: String(h.restarts) }
    : { active: "failed", sub: "failed", since: new Date(h.startedAt).toUTCString(), main_pid: null, restarts: String(h.restarts) };
  return {
    ts: t,
    ...(h.agentVersion ? { version: h.agentVersion } : {}),
    ...(h.agentProtocol != null ? { protocol: h.agentProtocol } : {}),
    platform: "linux",
    fingerprint: agentFingerprint(h),
    ...(canSelfUpdate(h) ? { self_update: true } : {}),
    system: {
      hostname: h.hostname,
      uptime_s: Math.round(86400 * 3 + (Date.now() - h.startedAt) / 1000),
      cpu_count: cores,
      cpu_pct: cpu,
      cpu_per_core: Array.from({ length: cores }, (_, i) => Math.round(Math.min(100, cpu * (0.4 + 1.2 * wave(t, 13, i / cores))) * 10) / 10),
      load: [cpu / 100 * cores, cpu / 100 * cores * 0.9, cpu / 100 * cores * 0.8].map((x) => Math.round(x * 100) / 100),
      mem: { total: memTotal, used: memUsed, available: memTotal - memUsed, pct: Math.round((memUsed / memTotal) * 1000) / 10 },
      swap: { total: 8 * GiB, used: 0, pct: 0 },
      disks,
      // a pull downloads at ~100 MB/s
      net: { rx_bps: Math.round(2e4 + 5e4 * wave(t, 17) + h.activePulls * 1e8), tx_bps: Math.round(1e4 + 3e4 * wave(t, 19)) },
      ollama_process: ollamaUp
        ? { pid: h.pid, rss_total: 450 * MiB + ps.reduce((s, m) => s + (m.size - m.size_vram), 0), runners: ps.filter((m) => !h.deadRunners.has(m.name)).length }
        : null,
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
  if (h.gpuLost === "restart") h.gpuLost = false;
  await newOllamaProcess(h);
  return { ok: true, stderr: "" };
}

/** The real agent's POST /gpu/reload-uvm on a bare-metal host: Ollama stops, nvidia_uvm reloads, Ollama starts. */
async function reloadUvm(h) {
  if (!h.gpus.length) throw new HttpErr(409, "the NVIDIA kernel driver isn't loaded on this host");
  logLine(h, "Stopping ollama.service...");
  h.gpuLost = false;
  await newOllamaProcess(h);
  const steps = ["systemctl stop ollama.service", "modprobe -r nvidia_uvm", "modprobe nvidia_uvm", "systemctl start ollama.service"];
  return { ok: true, steps: steps.map((cmd) => ({ cmd, ok: true, stderr: "" })), stderr: "" };
}

/** Ollama stops and starts again with a new process, as after systemctl restart or a crash that systemd recovers. */
async function newOllamaProcess(h) {
  h.restarts++;
  h.loaded.clear();
  h.deadRunners.clear();
  // a restart brings a crashed Ollama back, like systemctl restart would
  await setOllama(h, "down");
  await sleep(500);
  h.startedAt = Date.now();
  h.pid += 2;
  await setOllama(h, "up");
  ollamaStarted(h);
}

const agentRoutes = {
  "GET /health": (h) => ({
    ok: true, version: h.agentVersion ?? undefined, protocol: h.agentProtocol ?? undefined, platform: "linux", hostname: h.hostname,
    fingerprint: agentFingerprint(h), ...(canSelfUpdate(h) ? { self_update: true } : {}),
  }),
  "GET /update": (h) => ({ ...h.update }),
  "POST /update": async (h, req) => startUpdate(h, await readBody(req)),
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
  "GET /gpu-check": (h) => ({
    ts: Date.now() / 1000, platform: "linux",
    // the agents' GPU_LOG_RE
    log: { source: "journal", lines: h.runLog.filter((l) => /cuda|cudart|nvcuda|nvml|nvidia|rocm|\bhip\b|amdgpu|gpu|vram|inference compute|offload|library=/i.test(l)) },
    nvidia_uvm: { driver: h.gpus.length > 0, module: h.gpus.length > 0, device: h.gpus.length > 0, container: false, can_reload: h.gpus.length > 0 },
  }),
  "POST /gpu/reload-uvm": (h) => reloadUvm(h),
  "GET /runner-starts": (h, _req, url) => {
    const now = Date.now() / 1000;
    const since = Math.max(now - 86400, Math.min(Number(url.searchParams.get("since")) || now - 3600, now));
    const starts = h.log.filter((l) => /llama runner started in/.test(l)).map((l) => Date.parse(/time=(\S+)/.exec(l)[1]) / 1000).filter((t) => t >= since);
    return { ts: now, starts };
  },
  // the agents' answer shape; the simulated log has no lines in an unknown format, so nothing is skipped
  "GET /requests": (h, _req, url) => {
    const now = Date.now() / 1000;
    const s = Number(url.searchParams.get("since"));
    const since = Number.isFinite(s) && s > 0 ? s : now - 3600;
    const requests = h.requestLog.filter((x) => x.t > since && x.t <= now).slice(0, 5000);
    const more = requests.length === 5000;
    return { requests, until: more ? requests[requests.length - 1].t : now, more, skipped: 0 };
  },
};

const agentFingerprint = (h) => (h.agentTls ? h.tls.fingerprint : null);

// ------------------------------------------------------------------ agent updates
/** Simulated agent releases per platform, newest anywhere in the list, as GitHub lists them. */
const agentReleases = { linux: null, windows: null };
let releaseReads = 0;
const releasesOf = (platform) => agentReleases[platform] ?? [`v${repoAgentVersion()}`];
const isPre = (tag) => tag.includes("-");

function newestRelease(platform, channel) {
  const tags = releasesOf(platform).filter((t) => channel === "dev" || !isPre(t)).map((t) => t.replace(/^v/, ""));
  return tags.sort((a, b) => semverCmp(b, a))[0] ?? null;
}

/** Semver order, a prerelease before its release, as the installer and the dashboard compare. */
function semverCmp(a, b) {
  const p = (v) => {
    const [core, pre] = v.split(/-(.*)/s);
    return [...core.split(".").map(Number), pre ? pre.split(".") : null];
  };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  if (!x[3] || !y[3]) return (x[3] ? -1 : 0) - (y[3] ? -1 : 0);
  for (let i = 0; i < Math.max(x[3].length, y[3].length); i++) {
    const q = x[3][i], r = y[3][i];
    if (q === undefined || r === undefined) return q === undefined ? -1 : 1;
    if (q === r) continue;
    return /^\d+$/.test(q) && /^\d+$/.test(r) ? q - r : q < r ? -1 : 1;
  }
  return 0;
}

const canSelfUpdate = (h) => h.scenario.agent_update !== "none" && !!h.agentVersion;

/** The real agent runs the installer's updater, which reinstalls the agent and restarts it. */
function startUpdate(h, body) {
  const channel = body?.channel ?? "stable";
  if (channel !== "stable" && channel !== "dev") throw new HttpErr(400, 'channel must be "stable" or "dev"');
  if (h.update.state === "running") throw new HttpErr(409, "an update is already running");
  h.update = { state: "running" };
  setTimeout(async () => {
    if (h.scenario.agent_update === "fail") {
      h.update = { state: "failed", result: "exit-code", log: ["▸ Downloading the agent", "✖ paddock-agent-linux.mjs doesn't match the release's SHA256SUMS: the download is damaged or was changed. Nothing was installed"] };
      return;
    }
    const target = newestRelease("linux", channel);
    if (!target || target === h.agentVersion) {
      h.update = { state: "idle" };
      return;
    }
    // the restart: the port closes for a moment and the new version answers
    const was = h.scenario.agent;
    await setAgent(h, "down");
    await sleep(800);
    h.agentVersion = target;
    h.update = { state: "idle" };
    await setAgent(h, was === "down" ? "up" : was);
  }, 1500);
  return { ok: true, channel };
}

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
  if (!req.socket.encrypted && !h.agentHttp) {
    return sendJson(res, 426, { detail: "this agent only accepts HTTPS: use https:// in the agent URL", fingerprint: agentFingerprint(h) });
  }
  const route = agentRoutes[key];
  const before080 = !h.agentVersion || /^0\.[0-7]\./.test(h.agentVersion);
  if (!route || (before080 && /^\/(gpu|runner-starts)/.test(url.pathname))) return sendJson(res, 404, { detail: "not found" });
  if (url.pathname === "/update" && !canSelfUpdate(h)) return sendJson(res, 404, { detail: "not found" });
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
  const known = [
    ...Object.keys(SCENARIO_VALUES), "pull_seconds", "ollama_key", "agent_token", "ollama_version", "agent_version", "agent_protocol",
    "agent_http", "agent_tls", "agent_key", "ps_size_vram", "gpu_temp", "vram_pct", "disk_pct", "models_disk_pct", "crash", "gpu_lost",
  ];
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
  if (patch.agent_protocol !== undefined) {
    if (patch.agent_protocol !== null && !(Number.isInteger(patch.agent_protocol) && patch.agent_protocol >= 0)) {
      throw new HttpErr(400, "agent_protocol must be a whole number, or null");
    }
    h.agentProtocol = patch.agent_protocol;
  }
  if (patch.agent_tls !== undefined) h.agentTls = !!patch.agent_tls;
  if (patch.ps_size_vram !== undefined) h.psSizeVram = !!patch.ps_size_vram;
  if (patch.agent_http !== undefined) {
    if (!patch.agent_http && !h.agentTls) throw new HttpErr(400, "agent_http can't be off without agent_tls: the agents refuse to start then");
    h.agentHttp = !!patch.agent_http;
  }
  if (patch.agent_key !== undefined) {
    if (patch.agent_key !== "new") throw new HttpErr(400, 'agent_key must be "new"');
    newAgentKey(h);
    h.servers.agent.useKey();
    // like an agent restart: connections made with the old key end
    h.servers.agent.closeAllConnections();
  }
  const reading = (k, max) => {
    const v = patch[k];
    if (v === null) return null;
    if (typeof v !== "number" || !(v >= 0 && v <= max)) throw new HttpErr(400, `${k} must be a number from 0 to ${max}, or null`);
    return v;
  };
  if (patch.gpu_temp !== undefined) h.gpuTemp = reading("gpu_temp", 150);
  if (patch.vram_pct !== undefined) h.vramPct = reading("vram_pct", 100);
  if (patch.disk_pct !== undefined) h.diskPct = reading("disk_pct", 100);
  if (patch.models_disk_pct !== undefined) h.modelsDiskPct = reading("models_disk_pct", 100);
  if (patch.crash !== undefined) {
    if (patch.crash === "ollama") {
      logLine(h, "ollama.service: Main process exited, code=killed, status=9/KILL", "ERROR");
      await newOllamaProcess(h);
    } else if (patch.crash === "runner") {
      const first = psModels(h)[0];
      if (!first) throw new HttpErr(409, "no model is loaded, so there is no runner to exit");
      h.deadRunners.add(first.name);
      logLine(h, `llama runner for ${first.name} terminated: signal: segmentation fault`, "ERROR");
    } else throw new HttpErr(400, 'crash must be "ollama" or "runner"');
  }
  if (patch.gpu_lost !== undefined) {
    if (![false, "restart", "uvm"].includes(patch.gpu_lost)) throw new HttpErr(400, 'gpu_lost must be false, "restart" or "uvm"');
    if (patch.gpu_lost && !h.gpus.length) throw new HttpErr(409, "this host has no GPU to lose");
    if (patch.gpu_lost && !h.gpuLost) {
      logLine(h, "error looking up nvidia GPU memory", "WARN", ' error="cuda driver library failed to get device context 999"');
    }
    h.gpuLost = patch.gpu_lost;
  }
  if (patch.pull) h.scenario.pull = patch.pull;
  if (patch.agent_update) h.scenario.agent_update = patch.agent_update;
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
    agent_https_url: `${base.replace("http:", "https:")}:${h.agentPort}`,
    agent_fingerprint: agentFingerprint(h),
    agent_http: h.agentHttp,
    agent_token: h.agentToken,
    ollama_key: h.ollamaKey,
    gpus: h.gpus.length,
    pull_seconds: h.pullSeconds,
    ollama_version: h.ollamaVersion,
    agent_version: h.agentVersion,
    agent_protocol: h.agentProtocol,
    scenario: { ...h.scenario },
    ps_size_vram: h.psSizeVram,
    readings: { gpu_temp: h.gpuTemp, vram_pct: h.vramPct, disk_pct: h.diskPct, models_disk_pct: h.modelsDiskPct },
    gpu_lost: h.gpuLost,
  };
  if (!full) return view;
  return {
    ...view,
    models: [...h.models.keys()],
    loaded: psModels(h).map((m) => m.name),
    partial: Object.fromEntries(h.partial),
    pulls: h.pulls,
    restarts: h.restarts,
    pid: h.pid,
    dead_runners: [...h.deadRunners],
    requests: h.requests,
    answers_stopped: h.answersStopped,
  };
}

function configYaml() {
  const lines = [
    "# Generated by test/sim/paddock-sim.mjs for its simulated hosts.",
    "poll_interval: 2",
    "metrics_open: true",
    `agent_releases_url: http://${opts.bind === "0.0.0.0" ? "127.0.0.1" : opts.bind}:${opts.basePort}/_sim/github`,
    "instances:",
  ];
  for (const h of hosts.values()) {
    const v = hostView(h);
    lines.push(`  - id: ${h.id}`, `    name: ${h.id}`, `    ollama_url: ${v.ollama_url}`);
    if (h.ollamaKey) lines.push(`    ollama_proxy_key: ${JSON.stringify(h.ollamaKey)}`);
    lines.push(`    agent_url: ${v.agent_url}`, `    agent_token: ${JSON.stringify(h.agentToken)}`, "    tags: [sim]");
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ webhook receiver
/** name → { received: [{t, headers, body}], fail: [{status, retry_after}] } */
const webhooks = new Map();
const webhook = (name) => {
  if (!webhooks.has(name)) webhooks.set(name, { received: [], fail: [] });
  return webhooks.get(name);
};

async function handleWebhook(req, res, name, action) {
  const w = webhook(name);
  if (req.method === "GET" && !action) return sendJson(res, 200, { received: w.received });
  if (req.method === "DELETE" && !action) {
    webhooks.delete(name);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && action === "fail") {
    const b = await readBody(req);
    const status = Number(b.status), times = Number(b.times ?? 1);
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new HttpErr(400, "status must be an HTTP error status");
    for (let i = 0; i < times; i++) w.fail.push({ status, retry_after: b.retry_after ?? null });
    return sendJson(res, 200, { failing: w.fail.length });
  }
  if (req.method === "POST" && !action) {
    const f = w.fail.shift();
    if (f) {
      console.log(`paddock-sim: webhook ${name}: answered ${f.status}`);
      res.writeHead(f.status, { "Content-Type": "application/json", ...(f.retry_after != null ? { "Retry-After": String(f.retry_after) } : {}) });
      return res.end(JSON.stringify({ message: "simulated failure" }));
    }
    const body = await readBody(req);
    const { authorization, "content-type": contentType, "user-agent": userAgent } = req.headers;
    w.received.push({ t: Date.now() / 1000, headers: { authorization, "content-type": contentType, "user-agent": userAgent }, body });
    // Discord sends embeds, Slack text, the generic webhook a summary
    console.log(`paddock-sim: webhook ${name}: ${body.summary ?? body.embeds?.[0]?.title ?? body.text ?? "(message)"}`);
    res.writeHead(204);
    return res.end();
  }
  throw new HttpErr(405, "see the header of test/sim/paddock-sim.mjs");
}

// ------------------------------------------------------------------ model registry
// The Ollama registry's API as the dashboard reads it for models that aren't pulled: manifests, the
// config blob, and the weights blob through a redirect (registry.ollama.ai redirects to a CDN),
// with Range support. The weights are a real GGUF header followed by zeros. Any library/<name>:<tag>
// exists, made up from its name like a pull would, except names containing "missing".

/** A GGUF file's start: header and metadata, with a 1000-token vocabulary to skip over. */
function ggufHeader(m) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); parts.push(b); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); parts.push(b); };
  const str = (s) => { const b = Buffer.from(s); u64(b.length); parts.push(b); };
  const kvs = [
    ["general.architecture", 8, m.arch], ["general.name", 8, m.name],
    [`${m.arch}.context_length`, 4, m.ctx],
    ...Object.entries(ARCH_INFO).map(([k, v]) => [`${m.arch}.${k}`, 4, v]),
  ];
  parts.push(Buffer.from("GGUF"));
  u32(3);
  u64(291); // tensors; their infos aren't written, the dashboard never reads that far
  u64(kvs.length + 1);
  for (const [k, type, v] of kvs) {
    str(k);
    u32(type);
    if (type === 8) str(v);
    else u32(v);
  }
  str("tokenizer.ggml.tokens");
  u32(9);
  u32(8);
  u64(1000);
  for (let i = 0; i < 1000; i++) str(`tok${i}`);
  return Buffer.concat(parts);
}

function registryModel(repo, tag) {
  const name = repo.replace(/^library\//, "") + ":" + tag;
  if (/missing/.test(name)) throw new HttpErr(404, "manifest unknown");
  const m = makeModel(name);
  const config = Buffer.from(JSON.stringify({ model_format: "gguf", model_family: m.details.family, model_type: m.details.parameter_size, file_type: "Q4_K_M" }));
  return { m, config, configDigest: `sha256:${hash(config.toString())}`, weightsDigest: `sha256:${hash(m.name + " weights")}`, header: ggufHeader(m) };
}

function handleRegistry(req, res, url) {
  const man = /^\/_sim\/registry\/v2\/(.+)\/manifests\/([^/]+)$/.exec(url.pathname);
  if (man) {
    const r = registryModel(man[1], man[2]);
    registryBlobs.set(r.configDigest, r);
    registryBlobs.set(r.weightsDigest, r);
    // the digest a pull of this tag reports in /api/tags, as a registry may send it
    res.setHeader("Docker-Content-Digest", `sha256:${r.m.digest}`);
    return sendJson(res, 200, {
      schemaVersion: 2, mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: r.configDigest, size: r.config.length },
      layers: [
        { mediaType: "application/vnd.ollama.image.model", digest: r.weightsDigest, size: r.m.size },
        { mediaType: "application/vnd.ollama.image.template", digest: `sha256:${hash(r.m.template)}`, size: r.m.template.length },
      ],
    });
  }
  const blob = /^\/_sim\/registry\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
  if (blob) {
    // the registry sends blobs to its CDN, which the dashboard has to follow. Models named
    // "elsewhere…" go to another host (localhost instead of 127.0.0.1), which it must refuse
    const cdnPath = url.pathname.replace("/_sim/registry/", "/_sim/registry-cdn/");
    const elsewhere = /\/elsewhere/.test(blob[1]) && blob[2] !== registryBlobs.get(blob[2])?.configDigest;
    res.writeHead(307, { Location: elsewhere ? `http://localhost:${req.socket.localPort}${cdnPath}` : cdnPath });
    return res.end();
  }
  const cdn = /^\/_sim\/registry-cdn\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]+)$/.exec(url.pathname);
  if (!cdn) throw new HttpErr(404, "not found");
  const r = registryBlobs.get(cdn[2]);
  if (!r) throw new HttpErr(404, `blob unknown in ${cdn[1]}`);
  if (cdn[2] === r.configDigest) return sendJson(res, 200, JSON.parse(r.config.toString()));
  libraryRequests.push(`weights ${r.m.name} ${req.headers.range ?? ""}`);
  const size = r.m.size;
  const range = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = Math.min(size - 1, range?.[2] !== undefined ? Number(range[2]) : size - 1);
  if (start >= size) {
    res.writeHead(416);
    return res.end();
  }
  // only ever asked for the start: the header and a little after it
  const body = Buffer.alloc(Math.min(end - start + 1, 64 * MiB));
  if (start < r.header.length) r.header.copy(body, 0, start, Math.min(r.header.length, start + body.length));
  res.writeHead(range ? 206 : 200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, ...(range ? { "Content-Range": `bytes ${start}-${start + body.length - 1}/${size}` } : {}) });
  res.end(body);
}

// ------------------------------------------------------------------ ollama.com
// The library's search and tags pages, in the markup ollama.com serves (as of 2026), for the
// dashboard's library browser. Like the site, search pages after the first come only as htmx
// fragments (HX-Request: true): a plain request for one is redirected to /search. Models and sizes are made up like everything else here, and agree
// with what a pull or the registry gives for the same tag.
const LIBRARY = [
  { path: "library/qwen3", desc: "Qwen3 is the latest generation of large language models in the Qwen series.", caps: ["tools", "thinking"], sizes: ["0.6b", "4b", "8b", "14b", "32b"], latest: "8b", pulls: 42_600_000, ctx: 40960, days: 400 },
  { path: "library/llama3.2", desc: "Meta's Llama 3.2 goes small with 1B and 3B models.", caps: ["tools"], sizes: ["1b", "3b"], latest: "3b", pulls: 51_000_000, ctx: 131072, days: 700 },
  { path: "library/gemma3", desc: "The current, most capable model that runs on a single GPU.", caps: ["vision"], sizes: ["1b", "4b", "12b", "27b"], latest: "4b", pulls: 23_000_000, ctx: 131072, days: 200, input: "Text, Image" },
  { path: "library/nomic-embed-text", desc: "A high-performing open embedding model with a large token context window.", caps: ["embedding"], sizes: [], latest: "v1.5", pulls: 40_000_000, ctx: 2048, days: 900 },
  { path: "library/gpt-oss", desc: "OpenAI's open-weight models designed for powerful reasoning & agentic tasks.", caps: ["tools", "thinking", "cloud"], sizes: ["20b", "120b"], latest: "20b", pulls: 14_700_000, ctx: 131072, days: 30, cloud: ["20b-cloud", "120b-cloud"] },
  { path: "library/deepseek-r1", desc: "DeepSeek-R1 is a family of open reasoning models.", caps: ["tools", "thinking"], sizes: ["1.5b", "7b", "14b", "70b", "671b"], latest: "7b", pulls: 75_000_000, ctx: 131072, days: 160 },
  { path: "someone/tiny-coder", desc: "A small coding model.", caps: ["tools"], sizes: ["1.5b"], latest: "1.5b", pulls: 1234, ctx: 32768, days: 2 },
];
const LIBRARY_PAGE = 4;
const escHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const shortCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const pullName = (path) => path.replace(/^library\//, "");
const dayText = (d) => new Date(Date.UTC(2026, 10, 5) - d * 86_400_000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Every tag of a library model: latest, each size, and its quantizations. Aliases share a digest. */
function libraryTags(l) {
  const tags = [];
  const sizes = l.sizes.length ? l.sizes : [l.latest];
  for (const size of sizes) {
    const base = l.sizes.length ? size : "v1.5";
    for (const q of ["", "-q4_K_M", "-q8_0", "-fp16"]) {
      const tag = `${base}${q}`;
      const canonical = `${pullName(l.path)}:${base}${q === "" ? "-q4_K_M" : q}`;
      tags.push({ tag, digest: hash(canonical).slice(0, 12), size: makeModel(canonical).size });
    }
  }
  const latest = tags.find((t) => t.tag === l.latest);
  tags.unshift({ ...latest, tag: "latest" });
  for (const c of l.cloud ?? []) tags.push({ tag: c, digest: hash(c).slice(0, 12), size: null });
  return tags;
}

function librarySearchPage(url, htmx) {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const c = url.searchParams.get("c");
  const p = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  let found = LIBRARY.filter((l) => (!q || l.path.includes(q) || l.desc.toLowerCase().includes(q)) && (!c || l.caps.includes(c)));
  if (url.searchParams.get("o") === "newest") found = [...found].sort((a, b) => a.days - b.days);
  const slice = found.slice((p - 1) * LIBRARY_PAGE, p * LIBRARY_PAGE);
  const items = slice.map((l) => `
<li  class="border-t-[0.5px] border-line first:border-t-0">
  <a href="/${l.path}" class="group grid grid-cols-1 gap-x-4 px-4 py-6">
    <div class="flex min-w-0 items-baseline gap-2.5">
      <h2 class="min-w-0 truncate text-xl font-medium" title="${escHtml(pullName(l.path))}">
        <span >${escHtml(pullName(l.path))}</span>
      </h2>
      <span class="flex-none text-[15px] tabular-nums text-muted" title="Updated ${dayText(l.days)}">${l.days}d</span>
    </div>
    <div class="order-last mt-3 flex flex-wrap items-center gap-2">${l.caps.map((x) => `<span  class="inline-flex items-center rounded-md bg-indigo-50 px-2">${x}</span>`).join("")}
    </div>
    <p class="mt-1 line-clamp-2 text-[15px] leading-6 text-black">${escHtml(l.desc)}</p>
    <div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <span class="inline-flex items-center gap-1.5 tabular-nums" title="${l.pulls.toLocaleString("en-US")} downloads"><svg width="15" height="15" aria-hidden="true"><path d="M12 3.5v12"/></svg><span >${shortCount(l.pulls)}</span></span>
      <span class="inline-flex items-center gap-1.5 tabular-nums"><svg width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="1"/></svg><span >${libraryTags(l).length} tags</span></span>
      ${l.sizes.map((x) => `<span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2">${x}</span>`).join("\n      ")}
    </div>
  </a>
</li>`).join("\n");
  const more = p * LIBRARY_PAGE < found.length;
  const next = new URLSearchParams({ page: String(p + 1), ...(q ? { q } : {}) });
  // the last item loads the next page when it scrolls into view
  const sentinel = more ? `
<li   hx-get="/search?${escHtml(next)}"   hx-trigger="revealed"   hx-swap="outerHTML"   hx-target="this"   hx-include="[name=c], [name=o], [name=s]"   hx-replace-url="false" ></li>` : "";
  if (htmx && p > 1) return items + sentinel;
  return `<!doctype html><html><head><title>${escHtml(q)} · Ollama</title></head><body>
<div hidden data-result-count="${slice.length}" data-has-more="${more}"></div>
<ul role="list" class="overflow-hidden rounded-3xl">${items}${sentinel}</ul></body></html>`;
}

function libraryTagsPage(path) {
  const l = LIBRARY.find((x) => x.path === path);
  if (!l) return null;
  const name = pullName(path);
  const rows = libraryTags(l).map((t) => `
          <div class="group px-4 py-3">
            <a href="/${path}:${t.tag}" class="md:hidden flex flex-col space-y-[6px] group">
              <div class="flex items-center font-medium"><span class="group-hover:underline">${escHtml(name)}:${t.tag}</span></div>
              <div class="flex flex-col text-neutral-500 text-[13px]">
                <span>
                  <span class="font-mono">
                    ${t.digest}</span> • ${t.size === null ? "Low Usage" : `${(t.size / 1e9).toFixed(1)}GB`} • ${Math.round(l.ctx / 1024)}K context window  •
                  <span class="hidden sm:inline">
                    ${l.input ?? "Text"} input •
                    ${Math.round(l.days / 30)} months ago
                  </span>
                </span>
                  <div class="flex sm:hidden">
                    ${l.input ?? "Text"} input •
                    ${Math.round(l.days / 30)} months ago
                  </div>
              </div>
            </a>
            <div class="hidden md:flex flex-col space-y-[6px]">
              <span class="flex items-center font-medium col-span-6 group text-sm">
                <a href="/${path}:${t.tag}" class="group-hover:underline">${escHtml(name)}:${t.tag}</a>
              </span>
            </div>
          </div>`).join("");
  return `<!doctype html><html><head><title>${escHtml(name)}/tags</title><meta name="description" content="${escHtml(l.desc)}"/></head><body>
<main>
  <p class="flex space-x-5 text-[13px] font-medium text-neutral-500">
    <span class="flex items-center"><span >${shortCount(l.pulls)}</span><span class="hidden sm:flex">&nbsp;Downloads</span></span>
    <span class="flex items-center" title="Nov 5, 2026 8:18 PM UTC"><span class="hidden sm:flex">Updated&nbsp;</span><span >${l.days} days ago</span></span>
  </p>
  <div id="summary"><h2 id="summary-display"><span id="summary-content">
    ${escHtml(l.desc)}
  </span></h2></div>
  <div class="mb-0 flex flex-wrap gap-2">
    ${l.caps.map((x) => `<span class="inline-flex items-center rounded-md bg-indigo-50">${x}</span>`).join("\n    ")}
    ${l.sizes.map((x) => `<span  class="inline-flex items-center rounded-md bg-[#ddf4ff]">${x}</span>`).join("\n    ")}
  </div>
<section class="w-full max-w-full mt-8">
  <div class="min-w-full divide-y divide-gray-200">${rows}
  </div>
</section>
</main></body></html>`;
}

function handleLibrarySite(req, res, url) {
  const path = url.pathname.replace(/^\/_sim\/ollama\.com/, "");
  libraryRequests.push(path + url.search);
  let html = null;
  if (path === "/search") {
    if (Number(url.searchParams.get("page") ?? 1) > 1 && req.headers["hx-request"] !== "true") {
      res.writeHead(303, { Location: "/_sim/ollama.com/search" });
      return res.end();
    }
    html = librarySearchPage(url, req.headers["hx-request"] === "true");
  }
  const t = /^\/([^/]+\/[^/]+)\/tags$/.exec(path);
  if (t) html = libraryTagsPage(t[1]);
  if (html === null) {
    res.writeHead(404, { "Content-Type": "text/html" });
    return res.end("<html><body>Not found</body></html>");
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Paths the library site was asked for, so tests can see what the dashboard cached. */
const libraryRequests = [];

/** GitHub's releases API, for the dashboard's check for newer agents. */
async function handleGithub(req, res, url) {
  if (req.method === "GET" && url.pathname === "/_sim/github/requests") return sendJson(res, 200, { reads: releaseReads });
  if (req.method === "POST" && url.pathname === "/_sim/github/releases") {
    const body = await readBody(req);
    for (const p of ["linux", "windows"]) {
      if (body?.[p] === undefined) continue;
      if (!Array.isArray(body[p]) || !body[p].every((t) => /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(t))) throw new HttpErr(400, `${p} must be a list of tags like v1.2.3`);
      agentReleases[p] = body[p];
    }
    return sendJson(res, 200, { linux: releasesOf("linux"), windows: releasesOf("windows") });
  }
  const m = /^\/_sim\/github\/repos\/[^/]+\/([^/]+)\/releases$/.exec(url.pathname);
  if (req.method !== "GET" || !m) throw new HttpErr(404, "not found");
  releaseReads++;
  const platform = m[1].endsWith("-win-agent") ? "windows" : "linux";
  sendJson(res, 200, releasesOf(platform).map((tag) => ({
    tag_name: tag, draft: false, prerelease: isPre(tag),
    assets: [{ name: "SHA256SUMS" }, { name: `paddock-agent-${platform}.mjs` }],
  })));
}

/** Blobs by digest, filled as their manifests are served. */
const registryBlobs = new Map();

async function handleControl(req, res) {
  const url = new URL(req.url, "http://control");
  try {
    if (req.method === "GET" && /^\/_sim\/registry/.test(url.pathname)) return handleRegistry(req, res, url);
    if (req.method === "GET" && /^\/_sim\/ollama\.com\//.test(url.pathname)) return handleLibrarySite(req, res, url);
    if (req.method === "GET" && url.pathname === "/_sim/library-requests") return sendJson(res, 200, { requests: libraryRequests });
    if (url.pathname.startsWith("/_sim/github/")) return await handleGithub(req, res, url);
    const wh = /^\/_sim\/webhook\/([A-Za-z0-9_.-]+)(?:\/(fail))?$/.exec(url.pathname);
    if (wh) return await handleWebhook(req, res, wh[1], wh[2]);
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
      newAgentKey(h);
      h.servers.agent = agentServer(h);
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
    console.log(`paddock-sim: ${h.id}  Ollama ${v.ollama_url}${h.ollamaKey ? " (proxy key)" : ""}  agent ${v.agent_url}  ${h.gpus.length} GPU(s)`);
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
