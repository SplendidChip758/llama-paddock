// ===== Fit estimates
// Predict the memory a model needs at a context (weights + KV cache + compute buffers) and where it
// would sit on each host's GPUs, with the assumptions behind it. Measurements of the same model from
// /api/ps calibrate the formula. No "server-only": the model editor imports it to re-estimate live.
import { fmtBytes } from "./format";
import type { FitEstimate, FitHost, FitMeasurement, FitModel } from "./types";

const MiB = 1024 ** 2;
/** What Ollama keeps free on each CUDA GPU on top of the model, and OLLAMA_GPU_OVERHEAD */
const GPU_RESERVE = 457 * MiB;
/** Ollama's context when nothing sets one */
export const DEFAULT_CONTEXT = 4096;
const DEFAULT_BATCH = 512;
/** for the output buffer when the vocabulary size isn't reported: about the largest common vocabularies */
const DEFAULT_VOCAB = 152_064;
/** bytes per cached element; quantized types are blocks of 32 with a scale */
const KV_BYTES: Record<string, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };
/** below this share of headroom, a fit is a close call */
const CLOSE_MARGIN = 0.05;
/** state-space or hybrid architectures: their per-sequence state doesn't follow the KV formula */
const RECURRENT_ARCH = /mamba|rwkv|jamba|granitehybrid|nemotron_h|falcon_h1|lfm2|qwen3next|plamo2/i;
/** share of layers using the sliding window, where the architecture fixes it */
const SLIDING_SHARE: Record<string, number> = { gemma2: 1 / 2, gemma3: 5 / 6, gptoss: 1 / 2, "gpt-oss": 1 / 2, cohere2: 3 / 4 };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const first = (v: unknown): number | null => (Array.isArray(v) ? num(Math.max(0, ...v.map(Number).filter(Number.isFinite))) : num(v));
const tokens = (n: number) => n.toLocaleString("en-US");

// ============================================================================ inputs
/** The parts of /api/show (and the /api/tags entry) that the estimate uses. */
export function fitModel(
  name: string,
  show: { model_info?: Record<string, unknown> | null; parameters?: Record<string, unknown> | null },
  tag: { size?: number; digest?: string } | null,
  cloud: boolean,
): FitModel {
  const info = show.model_info ?? {};
  const arch = typeof info["general.architecture"] === "string" ? (info["general.architecture"] as string) : null;
  const k = (key: string) => (arch ? info[`${arch}.${key}`] : undefined);
  const layers = num(k("block_count"));
  const heads = first(k("attention.head_count"));
  const embedding = num(k("embedding_length"));
  const rawKv = k("attention.head_count_kv") ?? k("attention.head_count");
  let kv_heads: number[] | null = null;
  if (layers && Array.isArray(rawKv) && rawKv.length === layers) kv_heads = rawKv.map((x) => Math.max(0, Number(x) || 0));
  else if (layers && num(rawKv)) kv_heads = Array(layers).fill(rawKv);
  const headDim = heads && embedding ? embedding / heads : null;
  const tokensList = info["tokenizer.ggml.tokens"];
  const window = num(k("attention.sliding_window"));
  const share = arch ? SLIDING_SHARE[arch] : undefined;
  const p = show.parameters ?? {};
  return {
    name,
    digest: tag?.digest ?? null,
    weights: num(tag?.size),
    architecture: arch,
    max_context: num(k("context_length")),
    layers,
    kv_heads,
    heads,
    key_length: num(k("attention.key_length")) ?? headDim,
    value_length: num(k("attention.value_length")) ?? headDim,
    embedding,
    vocab: num(k("vocab_size")) ?? (Array.isArray(tokensList) && tokensList.length ? tokensList.length : null),
    sliding: window ? { window, layers: share !== undefined && layers ? Math.round(layers * share) : null } : null,
    recurrent: (!!arch && RECURRENT_ARCH.test(arch)) || Object.keys(info).some((x) => !!arch && x.startsWith(`${arch}.ssm.`)),
    num_ctx: num(p.num_ctx),
    num_gpu: typeof p.num_gpu === "number" && p.num_gpu >= 0 ? p.num_gpu : null,
    num_batch: num(p.num_batch),
    cloud,
  };
}

/** The settings a measured size depends on: two measurements calibrate each other only when these match. */
export function settingsKey(env: FitHost["env"]): string {
  if (!env) return "?";
  return `kv=${env.kv_cache_type ?? ""};fa=${env.flash_attention === null ? "" : env.flash_attention ? 1 : 0};np=${env.num_parallel ?? ""}`;
}

/** Ollama's environment, as the parts that change the estimate. */
export function fitEnv(env: Record<string, string> | null): FitHost["env"] {
  if (!env) return null;
  const bool = (v?: string) => (v === undefined || v.trim() === "" ? null : /^(1|true|yes|on)$/i.test(v.trim()));
  const int = (v?: string) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
  };
  return {
    kv_cache_type: env.OLLAMA_KV_CACHE_TYPE?.trim().toLowerCase() || null,
    flash_attention: bool(env.OLLAMA_FLASH_ATTENTION),
    num_parallel: int(env.OLLAMA_NUM_PARALLEL) || null,
    context_length: int(env.OLLAMA_CONTEXT_LENGTH) || null,
    gpu_overhead: int(env.OLLAMA_GPU_OVERHEAD),
  };
}

// ============================================================================ formula
interface Settings {
  parallel: number;
  batch: number;
  flash: boolean;
  /** bytes per KV cache element */
  kvBytes: number;
}

function settingsFor(m: FitModel, host: FitHost): { s: Settings; assumptions: string[]; doubts: number } {
  const env = host.env;
  const assumptions: string[] = [];
  let doubts = 0;
  if (!env) {
    assumptions.push("Ollama's environment isn't known without an agent: assumed defaults (1 parallel request, flash attention off, f16 KV cache).");
    doubts++;
  }
  const parallel = env?.num_parallel ?? 1;
  if (env && env.num_parallel === null) assumptions.push("OLLAMA_NUM_PARALLEL isn't set: assumed 1 request at a time. Older Ollama versions chose up to 4 by free memory.");
  else if (parallel > 1) assumptions.push(`OLLAMA_NUM_PARALLEL=${parallel}: the KV cache holds ${parallel} requests' contexts.`);
  const flash = env?.flash_attention ?? false;
  if (env && env.flash_attention === null) {
    assumptions.push("OLLAMA_FLASH_ATTENTION isn't set: assumed off. Recent Ollama versions turn it on by themselves for some models and GPUs, which makes the real size smaller.");
    doubts++;
  }
  const type = env?.kv_cache_type ?? "f16";
  let kvBytes = KV_BYTES.f16;
  if (type !== "f16") {
    if (!KV_BYTES[type]) assumptions.push(`OLLAMA_KV_CACHE_TYPE=${type} isn't a type Ollama knows: assumed f16.`);
    else if (flash) kvBytes = KV_BYTES[type];
    else assumptions.push(`OLLAMA_KV_CACHE_TYPE=${type} only applies with flash attention on: assumed f16.`);
  }
  if (flash && kvBytes !== KV_BYTES.f16) assumptions.push(`KV cache quantized to ${type}.`);
  return { s: { parallel, batch: m.num_batch ?? DEFAULT_BATCH, flash, kvBytes }, assumptions, doubts };
}

/** null when the model's metadata doesn't say enough. */
function formula(m: FitModel, ctx: number, s: Settings): { weights: number; kv: number; overhead: number; total: number } | null {
  if (!m.weights || !m.kv_heads || !m.key_length || !m.value_length) return null;
  const perCell = m.kv_heads.reduce((a, b) => a + b, 0) * (m.key_length + m.value_length) * s.kvBytes;
  // sliding-window layers only keep the window (plus a batch in flight)
  const share = m.sliding?.layers && m.layers ? m.sliding.layers / m.layers : 0;
  const windowed = share ? share * Math.min(ctx, m.sliding!.window + s.batch) : 0;
  const cells = ((1 - share) * ctx + windowed) * s.parallel;
  const kv = Math.round(perCell * cells);
  // compute buffers, after Ollama's own estimate: activations or the output logits, plus the
  // attention scores over the whole context when flash attention is off
  const embd = m.embedding ?? 4096;
  const attn = s.flash ? 0 : ctx * s.parallel * (1 + (m.heads ?? 32));
  const overhead = Math.round(4 * s.batch * Math.max(1 + 4 * embd + attn, embd + (m.vocab ?? DEFAULT_VOCAB)));
  return { weights: m.weights, kv, overhead, total: m.weights + kv + overhead };
}

/** Least squares through (context, size), for a size that grows linearly with the context. */
function line(points: { context: number; size: number }[]) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.context, 0) / n;
  const my = points.reduce((a, p) => a + p.size, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.context - mx) ** 2, 0);
  const slope = Math.max(0, points.reduce((a, p) => a + (p.context - mx) * (p.size - my), 0) / sxx);
  return (ctx: number) => my + slope * (ctx - mx);
}

type Prediction = NonNullable<ReturnType<typeof formula>> | null;
interface Predictor {
  at(ctx: number): { total: number; parts: Prediction; calibration: FitEstimate["calibration"]; extrapolated: boolean } | null;
}

/** The formula, corrected by what /api/ps reported for this model under the same settings. */
function predictor(m: FitModel, host: FitHost, measurements: FitMeasurement[], s: Settings): Predictor {
  const key = settingsKey(host.env);
  const matching = measurements.filter((x) => x.settings === key);
  // this host's own readings first: other hosts' GPUs can need different buffers
  const own = matching.filter((x) => x.instance === host.id);
  const byCtx = new Map<number, FitMeasurement>();
  for (const x of (own.length ? own : matching).sort((a, b) => a.t - b.t)) byCtx.set(x.context, x);
  const points = [...byCtx.values()].map((x) => ({ context: x.context, size: x.size })).sort((a, b) => a.context - b.context);
  const fitted = points.length >= 2 ? line(points) : null;
  return {
    at(ctx) {
      const parts = formula(m, ctx, s);
      const exact = points.find((p) => p.context === ctx);
      if (exact) return { total: exact.size, parts, calibration: { kind: "measured", points: [exact] }, extrapolated: false };
      const extrapolated = !points.length || ctx < points[0].context || ctx > points[points.length - 1].context;
      if (fitted) return { total: Math.round(fitted(ctx)), parts, calibration: { kind: "fitted", points }, extrapolated };
      if (points.length === 1 && parts) {
        const base = formula(m, points[0].context, s)!;
        // never below the weights: a measurement that is far off says more about the settings than the model
        const total = Math.max(m.weights ?? 0, parts.total + (points[0].size - base.total));
        return { total, parts, calibration: { kind: "offset", points }, extrapolated };
      }
      return parts ? { total: parts.total, parts, calibration: null, extrapolated: true } : null;
    },
  };
}

// ============================================================================ placement
interface Placement {
  verdict: "fits" | "offload" | "insufficient";
  gpu_pct: number;
  placement: string;
  capacity: number;
  /** bytes the model would hold in VRAM */
  vram: number;
  close: boolean;
  multi: boolean;
}

function usable(host: FitHost) {
  const extra = host.env?.gpu_overhead ?? 0;
  return (host.gpus ?? []).map((g) => ({ ...g, free: Math.max(0, g.total - g.other - GPU_RESERVE - extra) }));
}

/** The VRAM a model of `total` bytes could use: its best single GPU, or every GPU, which each need their own buffers. */
function capacityFor(host: FitHost, overhead: number) {
  const gpus = usable(host);
  const best = gpus.reduce((a, g) => (g.free > a.free ? g : a), gpus[0]);
  const all = gpus.reduce((a, g) => a + g.free, 0) - overhead * (gpus.length - 1);
  return { gpus, best, all };
}

function place(m: FitModel, host: FitHost, total: number, overhead: number): Placement {
  const ramFree = host.ram?.available ?? Infinity;
  const { gpus, best, all } = capacityFor(host, overhead);
  const cpuOnly = !gpus.length || m.num_gpu === 0;
  if (cpuOnly) {
    const where = m.num_gpu === 0 ? "on the CPU (num_gpu 0)" : "on the CPU (no GPU reported)";
    return { verdict: total <= ramFree ? "offload" : "insufficient", gpu_pct: 0, placement: where, capacity: 0, vram: 0, close: ramFree - total < total * CLOSE_MARGIN, multi: false };
  }
  if (total <= best.free) {
    return {
      verdict: "fits", gpu_pct: 100, placement: `GPU ${best.index} (${best.name})`, capacity: best.free, vram: total,
      close: best.free - total < best.free * CLOSE_MARGIN, multi: false,
    };
  }
  if (gpus.length > 1 && total <= all) {
    return { verdict: "fits", gpu_pct: 100, placement: `across ${gpus.length} GPUs`, capacity: all, vram: total, close: all - total < all * CLOSE_MARGIN, multi: true };
  }
  // Ollama offloads whole layers: roughly, what fits beside the buffers goes to the GPU
  const multi = gpus.length > 1 && all > best.free;
  const cap = multi ? all : best.free;
  const layered = total > overhead ? (cap - overhead) / (total - overhead) : 0;
  const gpu_pct = Math.min(99, Math.max(0, Math.round(layered * 100)));
  const vram = gpu_pct ? overhead + (gpu_pct / 100) * (total - overhead) : 0;
  const cpu = total - vram;
  return {
    verdict: cpu <= ramFree ? "offload" : "insufficient", gpu_pct,
    placement: multi ? `${gpus.length} GPUs and the CPU` : gpu_pct ? `GPU ${best.index} (${best.name}) and the CPU` : "the CPU",
    capacity: cap, vram, close: false, multi,
  };
}

/** The largest context that keeps the whole model in VRAM, rounded down; 0 when not even a small one does. */
function maxGpuContext(m: FitModel, host: FitHost, p: Predictor): number | null {
  const at = (ctx: number) => {
    const x = p.at(ctx);
    return x && place(m, host, x.total, x.parts?.overhead ?? 0).verdict === "fits";
  };
  const hi = m.max_context ?? 131_072;
  if (p.at(hi) === null) return null;
  if (at(hi)) return hi;
  let lo = 256;
  if (!at(lo)) return 0;
  let top = hi;
  while (top - lo > 256) {
    const mid = Math.floor((lo + top) / 2);
    if (at(mid)) lo = mid;
    else top = mid;
  }
  return lo >= 2048 ? Math.floor(lo / 1024) * 1024 : Math.floor(lo / 256) * 256;
}

// ============================================================================ estimate
/** The context the model would run with: the request's, else the Modelfile's, else the host's, else Ollama's default; capped at the model's. */
export function effectiveContext(m: FitModel, host: FitHost, requested?: number | null): { context: number; source: FitEstimate["context_source"] } {
  const pick: [number | null | undefined, FitEstimate["context_source"]][] = [
    [requested, "requested"], [m.num_ctx, "modelfile"], [host.env?.context_length, "env"],
  ];
  const [n, source] = pick.find(([v]) => v && v > 0) ?? [DEFAULT_CONTEXT, "default"];
  return { context: Math.min(Math.trunc(n!), m.max_context ?? Infinity), source };
}

const CONF = ["low", "medium", "high"] as const;

export function estimateFit(m: FitModel, host: FitHost, measurements: FitMeasurement[], requested?: number | null): FitEstimate {
  const { context, source } = effectiveContext(m, host, requested);
  const base: FitEstimate = {
    instance: host.id, instance_name: host.name, context, context_source: source, verdict: "unknown", confidence: null,
    total: null, weights: null, kv: null, overhead: null, formula_total: null, gpu_pct: null, placement: null, capacity: null,
    max_gpu_context: null, evicts: [], calibration: null, summary: "", assumptions: [],
  };
  if (m.cloud) return { ...base, verdict: "cloud", summary: "Cloud model: it runs on Ollama's servers and takes no memory on this host." };

  const { s, assumptions, doubts } = settingsFor(m, host);
  const p = predictor(m, host, measurements, s);
  const x = p.at(context);
  if (source === "default") assumptions.unshift(`No context is set: assumed Ollama's default of ${tokens(DEFAULT_CONTEXT)}. Some Ollama versions choose a larger one by free VRAM.`);
  if (!x) {
    const why = !m.weights ? "the model isn't pulled on this host, so its size isn't known" : "Ollama doesn't report the model's layer and attention sizes";
    return { ...base, assumptions, summary: `Insufficient information: ${why}.` };
  }
  const est: FitEstimate = {
    ...base, total: x.total, weights: x.parts?.weights ?? m.weights, kv: x.parts?.kv ?? null, overhead: x.parts?.overhead ?? null,
    formula_total: x.parts?.total ?? null, calibration: x.calibration, assumptions,
  };
  if (m.recurrent) assumptions.push("The model has recurrent (state-space) layers: their memory doesn't follow the KV cache formula, so the estimate is rough.");
  if (m.sliding && m.sliding.layers === null) assumptions.push("The model uses sliding-window attention on some layers, which ones isn't known here: the KV cache is estimated as if every layer kept the whole context, so the real size is smaller.");
  if (m.sliding?.layers) assumptions.push(`${m.sliding.layers} of ${m.layers} layers use a ${tokens(m.sliding.window)}-token sliding window and keep only that much.`);
  if (!m.vocab) assumptions.push("The vocabulary size isn't reported: the output buffer assumes a large one.");
  if (x.calibration?.kind === "measured") assumptions.unshift(`Measured: /api/ps reported this model at ${tokens(context)} tokens under the same settings.`);
  else if (x.calibration) {
    const at = x.calibration.points.map((q) => tokens(q.context)).join(", ");
    assumptions.unshift(`Calibrated against what /api/ps reported at ${at} tokens${x.extrapolated ? ", extrapolated beyond those contexts" : ""}.`);
  }
  if (!host.gpus) {
    return { ...est, summary: `Needs about ${fmtBytes(x.total)}. Insufficient information on where it fits: the GPUs aren't known without an agent.` };
  }

  const pl = place(m, host, x.total, x.parts?.overhead ?? 0);
  // confidence: measured beats calibrated beats formula; doubts about the settings and close calls lower it
  let c = x.calibration && !x.extrapolated ? 2 : 1;
  if (!x.calibration && doubts) c--;
  if (!x.calibration && (m.recurrent || (m.sliding && m.sliding.layers === null))) c = 0;
  if (pl.multi) {
    c--;
    assumptions.push("Ollama spreads a model that doesn't fit on one GPU across several by layers; each GPU then needs its own buffers, so the GPUs don't add up to one pooled device.");
  }
  if (pl.close) {
    c--;
    assumptions.push("Within 5% of the available memory: a small difference in Ollama's own estimate decides it.");
  }
  if (host.gpus.some((g) => g.other > 0)) assumptions.push("VRAM held by other processes on the GPU is left out of what's available.");
  const confidence = CONF[Math.max(0, Math.min(2, c))];

  const othersVram = host.loaded.reduce((a, l) => a + l.size_vram, 0);
  const evicts = pl.vram > 0 && pl.vram > pl.capacity - othersVram ? host.loaded.filter((l) => l.size_vram > 0).map((l) => l.name) : [];
  const max = host.gpus.length && m.num_gpu !== 0 ? maxGpuContext(m, host, p) : null;
  const needs = `about ${fmtBytes(x.total)}`;
  const summary =
    pl.verdict === "fits" ? `Likely fits on ${pl.placement}: ${needs} of ${fmtBytes(pl.capacity)} usable VRAM.`
    : pl.verdict === "offload" && pl.gpu_pct === 0 ? `Likely runs ${pl.placement}: ${needs} in system RAM.`
    : pl.verdict === "offload" ? `Likely partly on the CPU: about ${pl.gpu_pct}% in VRAM on ${pl.placement}, ${needs} in all.`
    : `Insufficient capacity: needs ${needs}, more than the free VRAM and system RAM together.`;
  return { ...est, verdict: pl.verdict, confidence, gpu_pct: pl.gpu_pct, placement: pl.placement, capacity: pl.capacity, max_gpu_context: max, evicts, summary };
}
