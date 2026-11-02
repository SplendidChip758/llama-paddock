// ===== GPU/CPU split of loaded models
// One definition for every view: the server adds `split` to each /api/ps entry in /api/instances, the
// UI labels and hints from it, and a "model partly on CPU" alert rule should test isOffloaded(). No
// "server-only": client components import it too.
import type { LoadedModel, ModelSplit, PsModel } from "./types";

const UNKNOWN: ModelSplit = { state: "unknown", gpu_pct: null, cpu_bytes: null };
const CLOUD: ModelSplit = { state: "cloud", gpu_pct: null, cpu_bytes: null };

/** Ollama's cloud tags: `gpt-oss:120b-cloud`, and the newer `gemma4:cloud` form. */
const CLOUD_NAME = /[:-]cloud$/i;

/**
 * Where a loaded model sits, from Ollama's /api/ps: `size` is the whole model as loaded (weights,
 * KV cache for its context, buffers) and `size_vram` the part of it in GPU memory. The rest is in
 * system RAM and runs on the CPU. Missing or inconsistent sizes give "unknown" rather than a guess,
 * since 0 VRAM would otherwise read as "100% CPU".
 */
export function modelSplit(m: { name?: string; size?: number | null; size_vram?: number | null }): ModelSplit {
  if (m.name && CLOUD_NAME.test(m.name)) return CLOUD;
  const { size, size_vram: vram } = m;
  if (typeof size !== "number" || typeof vram !== "number" || !Number.isFinite(size) || !Number.isFinite(vram)) return UNKNOWN;
  if (size <= 0 || vram < 0 || vram > size) return UNKNOWN;
  if (vram === size) return { state: "gpu", gpu_pct: 100, cpu_bytes: 0 };
  if (vram === 0) return { state: "cpu", gpu_pct: 0, cpu_bytes: size };
  // kept off 0 and 100 so a sliver on either side never reads as fully on one of them
  const gpu_pct = Math.min(99, Math.max(1, Math.round((vram / size) * 100)));
  return { state: "partial", gpu_pct, cpu_bytes: size - vram };
}

export const withSplit = (m: PsModel): LoadedModel => ({ ...m, split: modelSplit(m) });

/**
 * Some or all of the model runs on the CPU. This is what the "model partly on CPU" alert checks.
 * Unknown and cloud models are never offloaded: nothing is known, or nothing runs here.
 */
export const isOffloaded = (s: ModelSplit) => s.state === "partial" || s.state === "cpu";

/**
 * An Ollama cloud model: it runs on a remote host (ollama.com), so prompts sent to it leave the
 * network, and it takes no local VRAM. /api/tags reports `remote_host` for these; the name is the
 * fallback for responses without it.
 */
export function isCloudModel(m: { name: string; remote_host?: string | null; remote_model?: string | null }): boolean {
  return !!m.remote_host || !!m.remote_model || CLOUD_NAME.test(m.name);
}

/** "100% GPU", "62% GPU" ("38% CPU / 62% GPU" with `detail`), "100% CPU", "cloud" or "split unknown". */
export function splitText(s: ModelSplit, detail = false): string {
  switch (s.state) {
    case "gpu": return "100% GPU";
    case "cpu": return "100% CPU";
    case "partial": return detail ? `${100 - s.gpu_pct!}% CPU / ${s.gpu_pct}% GPU` : `${s.gpu_pct}% GPU`;
    case "cloud": return "cloud";
    default: return "split unknown";
  }
}

/**
 * What to look at when a model isn't fully on the GPU. Worded as likely causes, not as an error:
 * CPU-only hosts and deliberate partial offload are legitimate setups.
 */
export function splitHint(s: ModelSplit): string | null {
  switch (s.state) {
    case "partial":
      return `${100 - s.gpu_pct!}% of this model is in system RAM and runs on the CPU, which is usually much slower. ` +
        "Likely causes: the model plus its KV cache didn't fit in free VRAM (try a smaller num_ctx or quantization), " +
        "other loaded models are holding VRAM, or num_gpu limits how many layers go to the GPU.";
    case "cpu":
      return "None of this model is in VRAM, so it runs on the CPU. Expected on a host without a supported GPU. " +
        "Otherwise check num_gpu (0 keeps every layer on the CPU), free VRAM and other loaded models, " +
        "and whether Ollama found the GPU (Logs tab).";
    case "unknown":
      return "Ollama didn't report how much of this model is in VRAM.";
    default:
      return null;
  }
}

/** Tooltip and note for a cloud model's badge. /api/tags reports the remote host; /api/ps doesn't. */
export function cloudNote(remoteHost?: string | null): string {
  let where = "Ollama's cloud";
  try {
    if (remoteHost) where = new URL(remoteHost).hostname;
  } catch {
    /* not a URL: keep the generic wording */
  }
  return `Cloud model: it runs on ${where}, not on this host, so prompts sent to it leave your network.`;
}
