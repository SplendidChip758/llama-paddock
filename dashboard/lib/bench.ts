import "server-only";
import crypto from "node:crypto";
import { version as dashboardVersion } from "@/package.json";
import type { Instance } from "./config";
import { deleteBenchmark, getBenchmark, listBenchmarks, saveBenchmark, type StoredBenchmark } from "./db";
import { HttpError } from "./http-error";
import { streamChat, type ChatRequest } from "./prompt";
import { cancelJob, getState, listJobs, ollama, startTask, type TaskProgress } from "./server";
import { isCloudModel, modelSplit } from "./split";
import type {
  BenchCase, BenchCaseSummary, BenchConditions, BenchMode, BenchRun, BenchSpec, BenchStat, BenchmarkInfo, PromptStats, PsModel, TagModel,
} from "./types";

// Benchmarks (#32): the same prompts, run several times, with the conditions they ran under, saved in
// paddock.db. Each run is a test prompt (#17) timed by streamChat().

/** Bump when a prompt, an option or the way runs are made changes: results from different sets don't compare. */
export const BENCH_SET = "v1";
export const BENCH_CASES: BenchCase[] = ["short", "long_context", "long_generation"];
const DEFAULT_REPEAT = 3;
const MAX_REPEAT = 10;
const DEFAULT_CTX = 4096;
const MIN_CTX = 512;
const MAX_CTX = 262_144;
/** How long an unloaded model may take to leave /api/ps before a cold run gives up. */
const UNLOAD_TIMEOUT_MS = 60_000;
/** A run whose figures vary more than this between repetitions is flagged as noisy. */
export const NOISY_CV = 10;

/** Ollama settings that change how fast a model runs or how much memory it takes. */
const BENCH_ENV = [
  "OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_NUM_PARALLEL", "OLLAMA_CONTEXT_LENGTH", "OLLAMA_SCHED_SPREAD",
  "OLLAMA_GPU_OVERHEAD", "OLLAMA_NEW_ENGINE", "OLLAMA_LLM_LIBRARY", "CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES",
];

// ============================================================================ prompt set
/** A small seeded generator, so the long prompt is the same text on every host and every time. */
function lcg(seed: number) {
  let x = seed >>> 0;
  return (n: number) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x % n;
  };
}

const ITEMS = ["brass bolts", "copper fittings", "steel hinges", "oak dowels", "rubber gaskets", "glass jars", "wool blankets", "paper reels"];
const SHELVES = "ABCDEFGH";

/**
 * An inventory list sized to about 60% of the context (at most ~8,000 tokens), and a question
 * about one line of it: reading the list is what the case measures. Numbers tokenize densely, so
 * three characters per token keeps it inside the context for common tokenizers; runs record the
 * real prompt_eval_count.
 */
function longPrompt(numCtx: number): string {
  const rand = lcg(32);
  const chars = Math.min(Math.floor(numCtx * 0.6), 8192) * 3;
  const lines: string[] = [];
  let len = 0;
  for (let i = 1; len < chars; i++) {
    const line = `Crate ${String(i).padStart(4, "0")} holds ${10 + rand(90)} ${ITEMS[rand(ITEMS.length)]} on shelf ${SHELVES[rand(8)]}${1 + rand(9)}, last counted on day ${1 + rand(365)}.`;
    lines.push(line);
    len += line.length + 1;
  }
  const asked = lines[Math.floor(lines.length / 2)].slice(0, 10);
  return `Here is a warehouse inventory.\n\n${lines.join("\n")}\n\nWhat does ${asked} hold, and on which shelf? Answer in one sentence.`;
}

const CASE_PROMPTS: Record<BenchCase, { prompt: (numCtx: number) => string; num_predict: number }> = {
  short: { prompt: () => "Explain in three sentences why the sky is blue.", num_predict: 128 },
  long_context: { prompt: longPrompt, num_predict: 32 },
  long_generation: {
    prompt: () => "Count upwards from one, writing every number out in words and separating them with commas. Don't stop until you are told to.",
    num_predict: 512,
  },
};

/**
 * Ollama reuses the cached start of a prompt it has just read, which would make every repetition
 * after the first skip most of the prompt. A different first line each run stops that.
 */
function benchRequest(model: string, spec: BenchSpec, c: BenchCase, tag: string): ChatRequest {
  const { prompt, num_predict } = CASE_PROMPTS[c];
  return {
    model,
    messages: [{ role: "user", content: `[${tag}]\n${prompt(spec.num_ctx)}` }],
    options: { num_ctx: spec.num_ctx, num_predict, temperature: 0, seed: 42 },
  };
}

// ============================================================================ requests
interface BenchRequest {
  instances: string[];
  model: string;
  spec: BenchSpec;
}

const int = (v: unknown, name: string, def: number, min: number, max: number) => {
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `"${name}" must be a whole number from ${min} to ${max}`);
  return n;
};

export function parseBenchRequest(b: Record<string, unknown>): BenchRequest {
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!model || /\s/.test(model)) throw new HttpError(400, `"model" is required`);
  const ids = Array.isArray(b.instances) ? b.instances : typeof b.instance === "string" ? [b.instance] : [];
  if (!ids.length || !ids.every((x) => typeof x === "string" && x)) throw new HttpError(400, `"instances" must be a non-empty list of host ids`);
  const mode = b.mode ?? "warm";
  if (mode !== "warm" && mode !== "cold") throw new HttpError(400, `"mode" must be warm or cold`);
  let cases = BENCH_CASES;
  if (b.cases != null) {
    if (!Array.isArray(b.cases) || !b.cases.length || !b.cases.every((c) => BENCH_CASES.includes(c as BenchCase))) {
      throw new HttpError(400, `"cases" must be a non-empty list of ${BENCH_CASES.join(", ")}`);
    }
    cases = BENCH_CASES.filter((c) => (b.cases as unknown[]).includes(c));
  }
  return {
    instances: [...new Set(ids as string[])],
    model,
    spec: {
      set: BENCH_SET, cases, mode,
      repeat: int(b.repeat, "repeat", DEFAULT_REPEAT, 1, MAX_REPEAT),
      num_ctx: int(b.num_ctx, "num_ctx", DEFAULT_CTX, MIN_CTX, MAX_CTX),
    },
  };
}

// ============================================================================ running
function persist(b: StoredBenchmark) {
  try {
    saveBenchmark(b);
  } catch (e) {
    console.error(`[llama-paddock] saving benchmark ${b.id} failed:`, e);
  }
}

const busy = (instance: string) => listJobs().some((j) => j.kind === "benchmark" && j.instance === instance && j.state === "running");

/** Start the same benchmark on each host. Hosts run at once: they don't slow each other. */
export function startBenchmarks(req: BenchRequest): BenchmarkInfo[] {
  const states = req.instances.map(getState);
  const taken = states.filter((st) => busy(st.inst.id));
  // two benchmarks on one host would each measure the other's load
  if (taken.length) throw new HttpError(409, `a benchmark is already running on ${taken.map((st) => st.inst.name).join(", ")}`);
  const batch = crypto.randomBytes(6).toString("hex");
  const { spec } = req;
  const detail = `${spec.mode}, ${spec.repeat}× ${spec.cases.length} prompt${spec.cases.length === 1 ? "" : "s"} at ${spec.num_ctx} context`;
  return states.map((st) => {
    const b: StoredBenchmark = {
      id: crypto.randomBytes(6).toString("hex"), batch, instance: st.inst.id, instance_name: st.inst.name, model: req.model,
      state: "running", error: null, started: Date.now() / 1000, finished: null, spec, conditions: null, runs: [], warnings: [],
    };
    saveBenchmark(b);
    startTask("benchmark", st.inst, req.model, detail, b.id, async (progress, signal) => {
      try {
        await runBenchmark(b, st.inst, progress, signal);
        b.state = "done";
      } catch (e) {
        b.state = signal.aborted ? "cancelled" : "error";
        b.error = signal.aborted ? null : e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        b.finished = Date.now() / 1000;
        persist(b);
      }
    });
    return benchmarkInfo(b);
  });
}

const CASE_NAMES: Record<BenchCase, string> = { short: "short prompt", long_context: "long context", long_generation: "long generation" };

async function runBenchmark(b: StoredBenchmark, inst: Instance, progress: TaskProgress, signal: AbortSignal) {
  const { spec } = b;
  const total = spec.repeat * spec.cases.length;
  progress({ status: "reading the host", total });
  const tag = await findModel(inst, b.model);
  b.conditions = await conditions(inst, tag);
  persist(b);

  if (spec.mode === "warm") {
    // the first answer after a load is slower in ways that have nothing to do with the host: leave it out
    progress({ status: "loading the model" });
    const warmUp = benchRequest(b.model, spec, "short", `${b.id} warm-up`);
    await timedChat(inst, { ...warmUp, options: { ...warmUp.options, num_predict: 1 } }, signal);
  }

  for (let rep = 1; rep <= spec.repeat; rep++) {
    for (const c of spec.cases) {
      const n = b.runs.length + 1;
      progress({ status: `run ${n} of ${total}: ${CASE_NAMES[c]}${spec.mode === "cold" ? " (unloading first)" : ""}`, completed: n - 1 });
      if (spec.mode === "cold") await unload(inst, b.model, signal);
      const before = await loadedEntry(inst, b.model);
      const state: BenchMode = before && (before.context_length == null || before.context_length === spec.num_ctx) ? "warm" : "cold";
      const t = Date.now() / 1000;
      const stats = await timedChat(inst, benchRequest(b.model, spec, c, `${b.id} ${n}`), signal);
      const after = await loadedEntry(inst, b.model);
      b.runs.push({
        case: c, rep, t, state, stats,
        size: after?.size ?? null, size_vram: after?.size_vram ?? null, split: after ? modelSplit(after) : null, context: after?.context_length ?? null,
      });
      if (b.conditions.context == null && after?.context_length) b.conditions.context = after.context_length;
      persist(b);
    }
  }
  progress({ completed: total, status: "checking the model" });
  // a pull or a create during the runs would mean the later runs measured another model
  const now = await findModel(inst, b.model).catch(() => null);
  if (now && now.digest !== b.conditions.digest) b.warnings.push("The model changed while the benchmark ran (its digest is different now), so the runs may not all be of the same model.");
}

async function findModel(inst: Instance, model: string): Promise<TagModel> {
  const tags = await ollama<{ models: TagModel[] }>(inst, "GET", "/api/tags", undefined, 15_000);
  const m = tags.models?.find((x) => x.name === model || x.model === model);
  if (!m) throw new HttpError(404, `${model} isn't on ${inst.name}`);
  if (isCloudModel(m)) throw new HttpError(400, `${model} is an Ollama cloud model: it runs remotely, so a benchmark wouldn't measure this host`);
  return m;
}

async function loadedEntry(inst: Instance, model: string): Promise<PsModel | null> {
  const ps = await ollama<{ models: PsModel[] }>(inst, "GET", "/api/ps", undefined, 10_000);
  return ps.models?.find((m) => m.name === model || m.model === model) ?? null;
}

/** Ask Ollama to unload the model and wait until /api/ps no longer lists it. */
async function unload(inst: Instance, model: string, signal: AbortSignal) {
  await ollama(inst, "POST", "/api/generate", { model, keep_alive: 0 }, UNLOAD_TIMEOUT_MS);
  const until = Date.now() + UNLOAD_TIMEOUT_MS;
  while (await loadedEntry(inst, model)) {
    if (signal.aborted) throw new Error("cancelled");
    if (Date.now() > until) throw new Error(`Ollama didn't unload ${model} within ${UNLOAD_TIMEOUT_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function timedChat(inst: Instance, req: ChatRequest, signal: AbortSignal): Promise<PromptStats> {
  const events = await streamChat(inst, req, signal);
  for await (const e of events) {
    if (e.type === "done") return e.stats;
    if (e.type === "error") throw new Error(e.detail);
  }
  throw new Error(signal.aborted ? "cancelled" : "the answer ended before Ollama finished it");
}

/** What the host and model looked like when the benchmark started. */
async function conditions(inst: Instance, tag: TagModel): Promise<BenchConditions> {
  const st = getState(inst.id);
  const [v, ps] = await Promise.all([
    ollama<{ version: string }>(inst, "GET", "/api/version", undefined, 5000).catch(() => null),
    ollama<{ models: PsModel[] }>(inst, "GET", "/api/ps", undefined, 10_000).catch(() => null),
  ]);
  const stats = st.agent_ok ? st.stats : null;
  const env = st.env();
  return {
    digest: tag.digest ?? null,
    quantization: tag.details?.quantization_level || null,
    parameter_size: tag.details?.parameter_size || null,
    family: tag.details?.family || null,
    format: tag.details?.format || null,
    ollama_version: v?.version ?? st.version,
    agent_version: st.agent_version,
    dashboard_version: dashboardVersion,
    platform: stats?.platform ?? (stats ? "linux" : null),
    context: null,
    env: env && Object.fromEntries(BENCH_ENV.filter((k) => env[k]).map((k) => [k, env[k]])),
    gpus: stats?.nvidia.available ? stats.nvidia.gpus.map((g) => ({ name: g.name, mem_total_mib: g.mem_total_mib, driver: g.driver })) : stats ? [] : null,
    cpu_count: stats?.system.cpu_count ?? null,
    mem_total: stats?.system.mem.total ?? null,
    other_models: (ps?.models ?? []).map((m) => m.name).filter((n) => n !== tag.name),
  };
}

// ============================================================================ results
function stat(values: (number | null)[]): BenchStat | null {
  const xs = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)) : null;
  return { median, min: xs[0], max: xs.at(-1)!, cv: sd == null || !mean ? null : (sd / mean) * 100 };
}

const medianOf = (xs: (number | null)[]) => stat(xs)?.median ?? null;

/** Each case over its runs in the benchmark's mode; runs that found the model otherwise are counted, not used. */
export function summarize(spec: BenchSpec, runs: BenchRun[]): BenchCaseSummary[] {
  return spec.cases.map((c) => {
    const all = runs.filter((r) => r.case === c);
    const rs = all.filter((r) => r.state === spec.mode);
    const pick = (f: (s: PromptStats) => number | null) => stat(rs.map((r) => f(r.stats)));
    const vram = rs.map((r) => r.size_vram).filter((x): x is number => x != null);
    return {
      case: c, runs: rs.length, excluded: all.length - rs.length,
      tps: pick((s) => s.tps), prompt_tps: pick((s) => s.prompt_tps), ttft_ms: pick((s) => s.ttft_ms), load_ms: pick((s) => s.load_ms),
      prompt_tokens: medianOf(rs.map((r) => r.stats.prompt_tokens)), tokens: medianOf(rs.map((r) => r.stats.tokens)),
      size_vram: vram.length ? Math.max(...vram) : null, split: rs.at(-1)?.split ?? null,
    };
  });
}

/** What makes a result less comparable, worked out from what was recorded. */
function warnings(b: StoredBenchmark, summary: BenchCaseSummary[]): string[] {
  const out: string[] = [];
  const c = b.conditions;
  if (c && !c.env) out.push("This host has no agent (or it didn't answer), so its GPUs, driver and Ollama settings weren't recorded.");
  if (c?.other_models.length) out.push(`Other models were loaded when it started (${c.other_models.join(", ")}). They share the GPU memory and can make the host slower.`);
  if (c?.context && c.context !== b.spec.num_ctx) out.push(`Ollama ran the model with a context of ${c.context}, not the ${b.spec.num_ctx} asked for.`);
  const excluded = summary.reduce((s, x) => s + x.excluded, 0);
  if (excluded) {
    out.push(b.spec.mode === "warm"
      ? `${excluded} run${excluded === 1 ? "" : "s"} found the model unloaded (something else unloaded it or changed its context) and ${excluded === 1 ? "is" : "are"} left out of the figures.`
      : `${excluded} run${excluded === 1 ? "" : "s"} found the model still loaded and ${excluded === 1 ? "is" : "are"} left out of the figures.`);
  }
  if (b.runs.some((r) => r.split?.state === "partial" || r.split?.state === "cpu")) {
    out.push("The model didn't fit in VRAM at this context: part of it ran on the CPU, which is usually far slower.");
  }
  const cut = b.runs.find((r) => r.case === "long_context" && r.stats.prompt_tokens != null && r.stats.prompt_tokens + CASE_PROMPTS.long_context.num_predict >= b.spec.num_ctx);
  if (cut) out.push("The long prompt filled the context, so Ollama may have cut part of it off.");
  const noisy = summary.filter((s) => [s.tps, s.prompt_tps].some((x) => x?.cv != null && x.cv > NOISY_CV)).map((s) => CASE_NAMES[s.case]);
  if (noisy.length) out.push(`Speeds varied by more than ${NOISY_CV}% between runs (${noisy.join(", ")}): something else may have been using the host.`);
  return [...out, ...b.warnings];
}

export function benchmarkInfo(b: StoredBenchmark, withRuns = false): BenchmarkInfo {
  const summary = summarize(b.spec, b.runs);
  const { runs, warnings: _stored, ...rest } = b;
  return { ...rest, summary, warnings: warnings(b, summary), ...(withRuns ? { runs } : {}) };
}

export function listBenchmarkInfo(filter: { instance?: string; model?: string }, limit: number): BenchmarkInfo[] {
  return listBenchmarks(filter, limit).map((b) => benchmarkInfo(b));
}

export function benchmarkDetail(id: string): BenchmarkInfo {
  const b = getBenchmark(id);
  if (!b) throw new HttpError(404, "no such benchmark");
  return benchmarkInfo(b, true);
}

/** Cancel a running benchmark (it keeps the runs it finished), or delete a finished one. */
export function removeBenchmark(id: string) {
  const b = getBenchmark(id);
  if (!b) throw new HttpError(404, "no such benchmark");
  if (b.state === "running" && listJobs().some((j) => j.id === id && j.state === "running")) cancelJob(id);
  else deleteBenchmark(id);
}
