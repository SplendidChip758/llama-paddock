#!/usr/bin/env node
/**
 * llama-paddock agent
 * ===================
 * Runs directly on each Ollama host (LXC) as a systemd service. Zero npm
 * dependencies: it only needs Node.js >= 18.15.
 *
 * Exposes what the Ollama HTTP API can't:
 *   - system stats (CPU, memory, swap, disks, network, load, uptime)
 *   - nvidia-smi GPU metrics and per-process GPU memory
 *   - the Ollama systemd environment (read + edit the drop-in override)
 *   - service restart / status and recent journal logs
 *
 * Every endpoint except /health needs `Authorization: Bearer <PADDOCK_AGENT_TOKEN>`.
 *
 * Environment:
 *   PADDOCK_AGENT_TOKEN    required shared secret
 *   PADDOCK_AGENT_BIND     default 0.0.0.0
 *   PADDOCK_AGENT_PORT     default 11435
 *   PADDOCK_OLLAMA_UNIT    default ollama.service
 *   PADDOCK_OVERRIDE_PATH  default /etc/systemd/system/ollama.service.d/override.conf
 *   PADDOCK_DISK_PATHS     extra mount points to report, comma separated
 *   PADDOCK_AGENT_ENV_ALLOW extra variable names the dashboard may set, comma separated
 *                          (a trailing * allows a prefix: "HSA_*,MY_VAR"); see ENV_ALLOW
 *   PADDOCK_DRY_RUN        "1" = never call systemctl/journalctl (testing)
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const VERSION = "0.7.0-dev.1";
const TOKEN = process.env.PADDOCK_AGENT_TOKEN || "";
const UNIT = process.env.PADDOCK_OLLAMA_UNIT || "ollama.service";
const OVERRIDE_PATH =
  process.env.PADDOCK_OVERRIDE_PATH || "/etc/systemd/system/ollama.service.d/override.conf";
const DRY_RUN = process.env.PADDOCK_DRY_RUN === "1";
const EXTRA_DISKS = (process.env.PADDOCK_DISK_PATHS || "").split(",").map((s) => s.trim()).filter(Boolean);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Variables the dashboard may set. Anything else (LD_PRELOAD, CUDA_INJECTION64_PATH, HSA_TOOLS_LIB, …)
// could load code into Ollama, so a dashboard login or agent token must not be enough to set it.
// The host can extend the list through PADDOCK_AGENT_ENV_ALLOW; variables already in the drop-in
// that aren't listed are kept as they are and reported read-only.
const ENV_ALLOW = [
  "OLLAMA_*",
  "CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER", "HIP_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES", "GPU_DEVICE_ORDINAL",
  "HSA_OVERRIDE_GFX_VERSION", "GGML_CUDA_ENABLE_UNIFIED_MEMORY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ...(process.env.PADDOCK_AGENT_ENV_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean),
];
const envAllowed = (name) => ENV_ALLOW.some((p) => p.endsWith("*")
  ? name.toUpperCase().startsWith(p.slice(0, -1).toUpperCase())
  : name.toUpperCase() === p.toUpperCase());

// ------------------------------------------------------------------ helpers
function run(cmd, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : "")) });
    });
  });
}

function readText(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function num(v) {
  v = String(v).trim();
  if (["", "[N/A]", "N/A", "[Not Supported]", "Not Supported"].includes(v)) return null;
  const f = Number(v);
  return Number.isNaN(f) ? v : f;
}

// ------------------------------------------------------------------ CPU sampler
// CPU % needs two samples; keep a rolling sample every 2s.
let cpuPrev = os.cpus().map((c) => ({ ...c.times }));
let cpuNow = { total: 0, perCore: cpuPrev.map(() => 0) };
setInterval(() => {
  const cur = os.cpus().map((c) => ({ ...c.times }));
  let busyAll = 0, totalAll = 0;
  const perCore = cur.map((t, i) => {
    const p = cpuPrev[i] || t;
    const total = Object.values(t).reduce((a, b) => a + b, 0) - Object.values(p).reduce((a, b) => a + b, 0);
    const idle = t.idle - p.idle;
    busyAll += total - idle;
    totalAll += total;
    return total > 0 ? +(((total - idle) / total) * 100).toFixed(1) : 0;
  });
  cpuNow = { total: totalAll > 0 ? +((busyAll / totalAll) * 100).toFixed(1) : 0, perCore };
  cpuPrev = cur;
}, 2000).unref();

// ------------------------------------------------------------------ system stats
function meminfo() {
  const out = {};
  for (const line of (readText("/proc/meminfo") || "").split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

let netPrev = null;
function netRates() {
  let rx = 0, tx = 0;
  for (const line of (readText("/proc/net/dev") || "").split("\n").slice(2)) {
    const [iface, rest] = line.split(":");
    if (!rest || iface.trim() === "lo") continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  const now = Date.now() / 1000;
  let rx_bps = null, tx_bps = null;
  if (netPrev && now > netPrev.t) {
    rx_bps = Math.max(0, (rx - netPrev.rx) / (now - netPrev.t));
    tx_bps = Math.max(0, (tx - netPrev.tx) / (now - netPrev.t));
  }
  netPrev = { t: now, rx, tx };
  return { rx_bps, tx_bps };
}

function diskUsage(p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    return { path: p, total, used, free, pct: used + free > 0 ? +((used / (used + free)) * 100).toFixed(1) : 0 };
  } catch { return null; }
}

function ollamaProcesses() {
  let server = null, rss = 0, runners = 0;
  let pids = [];
  try { pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch { return null; }
  for (const pid of pids) {
    if ((readText(`/proc/${pid}/comm`) || "").trim() !== "ollama") continue;
    const args = (readText(`/proc/${pid}/cmdline`) || "").split("\0");
    const m = (readText(`/proc/${pid}/status`) || "").match(/VmRSS:\s+(\d+)/);
    rss += m ? Number(m[1]) * 1024 : 0;
    if (args.includes("serve")) server = Number(pid);
    else if (args.includes("runner")) runners++;
  }
  return server ? { pid: server, rss_total: rss, runners } : null;
}

function systemStats() {
  const mi = meminfo();
  const memTotal = mi.MemTotal || os.totalmem();
  const memAvail = mi.MemAvailable ?? os.freemem();
  const swapTotal = mi.SwapTotal || 0;
  const swapUsed = swapTotal - (mi.SwapFree || 0);

  const disks = [];
  const seen = new Set();
  const modelsDir = readEnvState().managed.OLLAMA_MODELS;
  for (const p of ["/", ...EXTRA_DISKS, ...(modelsDir ? [modelsDir] : [])]) {
    const d = diskUsage(p);
    if (!d) continue;
    const key = `${d.total}:${d.used}`;
    if (seen.has(key)) continue;
    seen.add(key);
    disks.push(d);
  }

  return {
    hostname: os.hostname(),
    uptime_s: Math.round(os.uptime()),
    cpu_count: os.cpus().length,
    cpu_pct: cpuNow.total,
    cpu_per_core: cpuNow.perCore,
    load: os.loadavg(),
    mem: { total: memTotal, used: memTotal - memAvail, available: memAvail, pct: +(((memTotal - memAvail) / memTotal) * 100).toFixed(1) },
    swap: { total: swapTotal, used: swapUsed, pct: swapTotal ? +((swapUsed / swapTotal) * 100).toFixed(1) : 0 },
    disks,
    net: netRates(),
    ollama_process: ollamaProcesses(),
  };
}

// ------------------------------------------------------------------ nvidia-smi
const GPU_FIELDS = [
  "index", "uuid", "name", "driver_version", "pstate", "temperature.gpu", "fan.speed",
  "utilization.gpu", "utilization.memory", "memory.used", "memory.total", "power.draw", "power.limit",
  "clocks.sm", "clocks.max.sm", "clocks.mem", "pcie.link.gen.current", "pcie.link.width.current",
];
const GPU_KEYS = [
  "index", "uuid", "name", "driver", "pstate", "temp_c", "fan_pct", "util_pct", "mem_util_pct",
  "mem_used_mib", "mem_total_mib", "power_w", "power_limit_w", "sm_clock_mhz", "sm_clock_max_mhz",
  "mem_clock_mhz", "pcie_gen", "pcie_width",
];
const TEXT_KEYS = new Set(["uuid", "name", "driver", "pstate"]);

// WSL puts nvidia-smi in /usr/lib/wsl/lib, which is on login shells' PATH but not on a systemd service's
const NVIDIA_SMI = fs.existsSync("/usr/lib/wsl/lib/nvidia-smi") ? "/usr/lib/wsl/lib/nvidia-smi" : "nvidia-smi";

async function nvidiaStats() {
  const q = await run(NVIDIA_SMI, [`--query-gpu=${GPU_FIELDS.join(",")}`, "--format=csv,noheader,nounits"]);
  if (q.code !== 0) {
    const missing = /ENOENT/.test(q.stderr);
    return { available: false, error: missing ? "nvidia-smi not found" : (q.stderr || q.stdout).trim(), gpus: [], processes: [] };
  }
  const gpus = q.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const parts = line.split(",").map((s) => s.trim());
    return Object.fromEntries(GPU_KEYS.map((k, i) => [k, TEXT_KEYS.has(k) ? parts[i] : num(parts[i])]));
  }).filter((g) => g.uuid);

  const p = await run(NVIDIA_SMI, ["--query-compute-apps=gpu_uuid,pid,process_name,used_memory", "--format=csv,noheader,nounits"]);
  const processes = p.code !== 0 ? [] : p.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [gpu_uuid, pid, name, mem] = line.split(",").map((s) => s.trim());
    return { gpu_uuid, pid: num(pid), name, mem_mib: num(mem) };
  });
  return { available: true, gpus, processes };
}

// ------------------------------------------------------------------ systemd env
/** Split a systemd Environment= value into tokens (handles "quotes", 'quotes', \escapes). */
function splitWords(s) {
  const out = [];
  let cur = "", quote = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}

function parseOverride(text) {
  const env = {};
  const other = [];
  let section = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) { section = line; other.push(raw); continue; }
    if (section === "[Service]" && line.startsWith("Environment=")) {
      for (const tok of splitWords(line.slice("Environment=".length))) {
        const eq = tok.indexOf("=");
        if (eq > 0) env[tok.slice(0, eq)] = tok.slice(eq + 1).replaceAll("%%", "%");
      }
      continue;
    }
    other.push(raw);
  }
  while (other.length && !other[other.length - 1].trim()) other.pop();
  return { env, other };
}

function quoteEnv(k, v) {
  // C-style escapes inside quotes; "%" starts a systemd unit specifier
  const s = `${k}=${v}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `Environment="${s}"`;
}

function renderOverride(env, other) {
  const envLines = Object.entries(env).map(([k, v]) => quoteEnv(k, v));
  const out = [];
  let serviceSeen = false;
  for (const line of other) {
    out.push(line);
    if (line.trim() === "[Service]") { serviceSeen = true; out.push(...envLines); }
  }
  if (!serviceSeen) {
    if (out.length && out[out.length - 1].trim()) out.push("");
    out.push("[Service]", ...envLines);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n") + "\n";
}

function readEnvState() {
  const raw = readText(OVERRIDE_PATH) ?? "";
  return { managed: parseOverride(raw).env, override_path: OVERRIDE_PATH, raw, allowed: ENV_ALLOW };
}

async function effectiveEnv() {
  if (DRY_RUN) return {};
  const r = await run("systemctl", ["show", UNIT, "-p", "Environment", "--value"]);
  if (r.code !== 0) return {};
  const env = {};
  for (const tok of splitWords(r.stdout.trim())) {
    const eq = tok.indexOf("=");
    if (eq > 0) env[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return env;
}

async function serviceStatus() {
  if (DRY_RUN) return { active: "dry-run", since: null, main_pid: null };
  const r = await run("systemctl", ["show", UNIT, "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestamp", "-p", "MainPID", "-p", "NRestarts"]);
  const props = Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return {
    active: props.ActiveState || null,
    sub: props.SubState || null,
    since: props.ActiveEnterTimestamp || null,
    main_pid: /^\d+$/.test(props.MainPID || "") ? Number(props.MainPID) : null,
    restarts: props.NRestarts || null,
  };
}

async function restartService() {
  if (DRY_RUN) return { ok: true, dry_run: true };
  const r1 = await run("systemctl", ["daemon-reload"], 30_000);
  const r2 = await run("systemctl", ["restart", UNIT], 90_000);
  return { ok: r1.code === 0 && r2.code === 0, stderr: (r1.stderr + r2.stderr).trim() };
}

async function putEnv(body) {
  const vars = body?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) throw httpError(400, "body must be {vars: {...}, restart?: bool}");
  const current = readText(OVERRIDE_PATH);
  const { env: existing, other } = parseOverride(current ?? "");
  for (const [k, v] of Object.entries(vars)) {
    if (!KEY_RE.test(k)) throw httpError(400, `invalid variable name: ${JSON.stringify(k)}`);
    if (typeof v !== "string") throw httpError(400, `value of ${k} must be a string`);
    if (/[\r\n]/.test(v)) throw httpError(400, `newlines not allowed in value of ${k}`);
    if (!envAllowed(k) && existing[k] !== v) {
      throw httpError(400, `${k} is not an Ollama variable; add it to PADDOCK_AGENT_ENV_ALLOW on the host to manage it here`);
    }
  }
  // variables outside the allowlist stay exactly as they are, whether or not the request mentions them
  const kept = Object.fromEntries(Object.entries(existing).filter(([k]) => !envAllowed(k)));
  const content = renderOverride({ ...kept, ...vars }, other);

  fs.mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
  if (current !== null) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    // .bak suffix keeps backups out of systemd's *.conf glob
    fs.copyFileSync(OVERRIDE_PATH, `${OVERRIDE_PATH}.paddock-${stamp}.bak`);
    const dir = path.dirname(OVERRIDE_PATH), base = path.basename(OVERRIDE_PATH);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.paddock-`) && f.endsWith(".bak")).sort();
    for (const old of backups.slice(0, -10)) fs.rmSync(path.join(dir, old), { force: true });
  }
  const tmp = `${OVERRIDE_PATH}.paddock-tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, OVERRIDE_PATH);

  const result = { written: OVERRIDE_PATH, content };
  if (body.restart !== false) result.restart = await restartService();
  else if (!DRY_RUN) await run("systemctl", ["daemon-reload"], 30_000);
  return result;
}

// ------------------------------------------------------------------ HTTP
function httpError(status, detail) {
  return Object.assign(new Error(detail), { status });
}

function authorized(req) {
  const h = req.headers.authorization || "";
  const supplied = Buffer.from(h.toLowerCase().startsWith("bearer ") ? h.slice(7) : "");
  const expected = Buffer.from(TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw httpError(413, "body too large");
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { throw httpError(400, "invalid JSON"); }
}

const routes = {
  "GET /health": async () => ({ ok: true, version: VERSION, platform: "linux", hostname: os.hostname() }),
  "GET /stats": async () => {
    const [nvidia, service] = await Promise.all([nvidiaStats(), serviceStatus()]);
    return { ts: Date.now() / 1000, version: VERSION, platform: "linux", system: systemStats(), nvidia, service };
  },
  "GET /env": async () => {
    const st = readEnvState();
    const effective = await effectiveEnv();
    const external = Object.fromEntries(Object.entries(effective).filter(([k]) => !(k in st.managed)));
    return { ...st, platform: "linux", effective, external };
  },
  "PUT /env": async (req) => putEnv(await readJson(req)),
  "POST /service/restart": async () => restartService(),
  "GET /logs": async (_req, url) => {
    const lines = Math.max(10, Math.min(Number(url.searchParams.get("lines")) || 200, 2000));
    if (DRY_RUN) return { lines: ["(dry run: journalctl disabled)"] };
    const r = await run("journalctl", ["-u", UNIT, "-n", String(lines), "--no-pager", "-o", "short-iso"], 15_000);
    return { lines: r.code === 0 ? r.stdout.split("\n").filter((l) => l.length) : [r.stderr.trim()] };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://agent");
  const handler = routes[`${req.method} ${url.pathname}`];
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!handler) return send(404, { detail: "not found" });
  if (url.pathname !== "/health" && !authorized(req)) return send(401, { detail: "invalid agent token" });
  try {
    send(200, await handler(req, url));
  } catch (e) {
    send(e.status || 500, { detail: e.message });
  }
});

if (!TOKEN) {
  console.error("PADDOCK_AGENT_TOKEN must be set");
  process.exit(1);
}
const port = Number(process.env.PADDOCK_AGENT_PORT || 11435);
const bind = process.env.PADDOCK_AGENT_BIND || "0.0.0.0";
server.listen(port, bind, () => console.log(`llama-paddock agent ${VERSION} listening on ${bind}:${port}`));
