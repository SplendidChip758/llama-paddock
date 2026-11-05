// ===== GPU check
// Ollama falls back to the CPU without an error when it can't use the GPU: after a suspend and
// resume (on Linux nvidia_uvm loses the device), a driver or Ollama update, or on a host that mixes
// AMD and NVIDIA GPUs. nvidia-smi still shows the GPU, so everything looks fine until models get
// slow. diagnoseGpu() compares where /api/ps puts the loaded models with what nvidia-smi sees, and
// explains it with evidence the poller reads from the agent when something changes: Ollama's log
// since it started, its environment, the Modelfiles of models on the CPU and the nvidia_uvm module.
// The Monitor tab and the gpu_lost alert rule both use its result.
import "server-only";
import { modelSplit } from "./split";
import type { AgentGpuCheck, AgentStats, GpuCheck, GpuFix, GpuStats, Platform, PsModel } from "./types";

/** The agents' GPU_LOG_RE, for agents before 0.8.0: the dashboard then filters their /logs itself. */
const GPU_LOG_RE = /cuda|cudart|nvcuda|nvml|nvidia|rocm|\bhip\b|amdgpu|gpu|vram|inference compute|offload|library=/i;
export const isGpuLogLine = (l: string) => GPU_LOG_RE.test(l) && !l.includes("[GIN]");

// What the lines say. Ollama's wording changes between versions, so each fact has a few forms.
const FOUND_RE = [/inference compute.*library="?(cuda|rocm|metal|vulkan|oneapi)/i, /ggml_cuda_init: found [1-9]\d* CUDA devices/i];
const NONE_RE = [/no compatible GPUs were discovered/i, /inference compute.*library="?cpu\b/i, /"total vram"="0 B"/i];
// older Ollama versions turned the GPU off on CPUs without AVX, such as a VM with a generic CPU type
const NO_AVX_RE = /GPU inference disabled|minimum vector extensions/i;
const NVIDIA_RE = /cuda|cudart|nvcuda|nvml|nvidia|cublas/i;
const FAIL_RE = /\b(error|errors|fail|fails|failed|failure|unable|insufficient|mismatch)\b|level=ERROR/i;
// running out of VRAM is a full GPU, not a lost one
const NOT_LOST_RE = /out of memory|\boom\b/i;
const CODE_999_RE = /\b999\b|CUDA_ERROR_UNKNOWN/i;
const MISMATCH_RE = /driver\/library version mismatch|driver version is insufficient/i;
// lines that show an AMD GPU is present, not just Ollama looking for one
const AMD_RE = /library="?rocm|amdgpu (is )?not supported|\bgfx\d{3,4}\b/i;
const ZERO_LAYERS_RE = /offloaded 0\/\d+ layers to GPU/i;
const SHOWN_LINES = 20;

export interface LogFacts {
  /** what the latest GPU discovery in this run of Ollama found: a GPU, none, or there was none in the lines */
  found: boolean | null;
  /** NVIDIA/CUDA errors since the latest discovery that found a GPU */
  errors: string[];
  code999: boolean;
  mismatch: boolean;
  amd: boolean;
  /** a model was loaded with none of its layers on the GPU */
  zero_layers: boolean;
  /** Ollama turned the GPU off because the CPU lacks AVX */
  no_avx: boolean;
  /** the lines worth showing: discoveries, errors and models placed on the CPU */
  shown: string[];
}

export function readLog(lines: string[]): LogFacts {
  let found: boolean | null = null;
  let errors: string[] = [];
  let amd = false, zero = false, noAvx = false;
  const shown: string[] = [];
  for (const l of lines) {
    if (AMD_RE.test(l)) amd = true;
    if (FOUND_RE.some((r) => r.test(l))) {
      found = true;
      errors = [];
      shown.push(l);
    } else if (NONE_RE.some((r) => r.test(l)) || NO_AVX_RE.test(l)) {
      found = false;
      if (NO_AVX_RE.test(l)) noAvx = true;
      shown.push(l);
    } else if (NVIDIA_RE.test(l) && FAIL_RE.test(l) && !NOT_LOST_RE.test(l)) {
      errors.push(l);
      shown.push(l);
    } else if (ZERO_LAYERS_RE.test(l)) {
      zero = true;
      shown.push(l);
    }
  }
  return {
    found, errors, amd, zero_layers: zero, no_avx: noAvx, shown: shown.slice(-SHOWN_LINES),
    code999: errors.some((l) => CODE_999_RE.test(l)), mismatch: errors.some((l) => MISMATCH_RE.test(l)),
  };
}

/** What the poller read from the agent and Ollama to explain the placement. */
export interface GpuEvidence {
  /** unix seconds */
  t: number;
  /** the run of Ollama it was read in; see ollamaRun() */
  run: string;
  platform: Platform;
  facts: LogFacts;
  log_error: string | null;
  /** only the end of the log was read: agents before 0.8.0 */
  log_partial: boolean;
  uvm: AgentGpuCheck["nvidia_uvm"] | null;
  /** Ollama's environment, empty if the agent couldn't say */
  env: Record<string, string>;
  /** the models (modelKey) on the CPU when it was read, and whether their Modelfile sets num_gpu 0 */
  models: Record<string, boolean>;
}

/** One run of Ollama: the log and the discovery in it belong to it, so evidence from another run is stale. */
export const ollamaRun = (stats: AgentStats) => `${stats.system.ollama_process?.pid ?? "-"}/${stats.service.since ?? "-"}`;
export const modelKey = (m: PsModel) => `${m.name}@${m.digest}`;
export const onCpu = (ps: PsModel[]) => ps.filter((m) => modelSplit(m).state === "cpu");

/** The host as the poller last saw it. */
export interface GpuHost {
  agent_ok: boolean;
  ollama_ok: boolean;
  stats: AgentStats | null;
  ps: PsModel[];
}

const fmtGB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const names = (list: string[]) => (list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`);

/**
 * Whether Ollama uses the NVIDIA GPU that nvidia-smi sees. null when there's nothing to check: no
 * agent answering, no NVIDIA GPU, or Ollama down. Missing telemetry is never taken for a lost GPU,
 * and a CPU placement that a setting asks for is "cpu_intended", not "lost".
 */
export function diagnoseGpu(h: GpuHost, ev: GpuEvidence | null): GpuCheck | null {
  const stats = h.agent_ok ? h.stats : null;
  const gpus = stats?.nvidia.available ? stats.nvidia.gpus : [];
  if (!stats || !gpus.length || !h.ollama_ok) return null;
  const fresh = ev && ev.run === ollamaRun(stats) ? ev : null;
  const facts = fresh?.facts ?? null;
  const gpuText = gpus.map((g) => `GPU${g.index} (${g.name})`).join(", ");

  const local = h.ps.map((m) => ({ m, s: modelSplit(m) })).filter((x) => x.s.state !== "cloud");
  const gpuModels = local.filter((x) => x.s.state === "gpu" || x.s.state === "partial").map((x) => x.m.name);
  const cpuModels = local.filter((x) => x.s.state === "cpu").map((x) => x.m);

  const evidence = [`nvidia-smi sees ${gpuText}${gpus[0].driver ? `, driver ${gpus[0].driver}` : ""}.`];
  if (gpuModels.length) evidence.push(`Loaded on the GPU: ${names(gpuModels)}.`);
  if (cpuModels.length) evidence.push(`Loaded entirely on the CPU: ${names(cpuModels.map((m) => m.name))}.`);
  if (!local.length) evidence.push("No local model is loaded.");
  else if (!gpuModels.length && !cpuModels.length) evidence.push("Ollama doesn't report how much of the loaded models is in VRAM.");
  if (facts) {
    if (facts.found !== null) evidence.push(facts.found ? "Ollama found a GPU when it last looked for one." : "Ollama found no compatible GPU when it last looked for one.");
    if (facts.errors.length) evidence.push(`Ollama logged ${facts.errors.length} GPU error${facts.errors.length === 1 ? "" : "s"} since then.`);
    if (facts.zero_layers) evidence.push("Ollama loaded a model with none of its layers on the GPU.");
  }
  const uvm = fresh?.platform === "linux" && fresh.uvm?.driver ? fresh.uvm : null;
  if (uvm) {
    evidence.push(`nvidia_uvm is ${uvm.module ? "loaded" : "not loaded"}, and /dev/nvidia-uvm ${uvm.device ? "exists" : "is missing"}${uvm.container ? " in this container" : ""}.`);
  }

  // models loaded on the CPU since the log was read: the errors that explain them may be newer than the read
  const current = !!fresh && cpuModels.every((m) => modelKey(m) in fresh.models);
  const notes: string[] = [];
  if (!fresh) notes.push("Ollama's log hasn't been read since it last started, so this rests on /api/ps alone.");
  else if (!current) notes.push("Models moved to the CPU after Ollama's log was last read. It is read again within a few polls.");
  if (fresh?.log_partial) {
    notes.push("This agent is older than 0.8.0, so only the end of Ollama's log was read, which can miss the GPU discovery at startup. Update the agent for the full check.");
  }
  if (fresh?.log_error) notes.push(`Ollama's log couldn't be read: ${fresh.log_error}`);
  const base = { evidence, log_lines: facts?.shown ?? [], checked_at: fresh?.t ?? null, notes };

  const intent = gpuModels.length ? null : cpuIntent(fresh, cpuModels);
  if (intent) return { state: "cpu_intended", summary: `${intent}, so Ollama runs on the CPU on purpose.`, causes: [], fixes: [], ...base };
  if (gpuModels.length) {
    return { state: "ok", summary: `Ollama runs ${gpuModels.length === 1 ? gpuModels[0] : `${gpuModels.length} models`} on the GPU.`, causes: [], fixes: [], ...base };
  }

  let summary: string;
  if (cpuModels.length) {
    const n = cpuModels.length;
    summary = `${n === 1 ? cpuModels[0].name : `${n} models`} run${n === 1 ? "s" : ""} entirely on the CPU while nvidia-smi sees ${gpuText}.`;
  } else if (facts?.errors.length) {
    summary = "Ollama logged GPU errors since it last found the GPU, so the next model will likely load on the CPU.";
  } else if (facts?.found === false) {
    summary = `Ollama found no compatible GPU when it started, while nvidia-smi sees ${gpuText}.`;
  } else if (facts?.found) {
    return { state: "ok", summary: "Ollama found the GPU when it started. No model is loaded to show it in use.", causes: [], fixes: [], ...base };
  } else {
    return { state: "unknown", summary: "No model is loaded, and Ollama's log doesn't say whether it found the GPU. Load a model to check.", causes: [], fixes: [], ...base };
  }
  return { state: "lost", summary, ...explain(fresh, current, gpus, cpuModels), ...base };
}

/** A setting that keeps Ollama on the CPU on purpose. */
function cpuIntent(ev: GpuEvidence | null, cpuModels: PsModel[]): string | null {
  const env = ev?.env ?? {};
  if (env.CUDA_VISIBLE_DEVICES?.trim() === "-1") return "CUDA_VISIBLE_DEVICES=-1 hides the NVIDIA GPUs from Ollama";
  if (/^cpu/i.test(env.OLLAMA_LLM_LIBRARY ?? "")) return `OLLAMA_LLM_LIBRARY=${env.OLLAMA_LLM_LIBRARY} makes Ollama use the CPU`;
  if (ev && cpuModels.length && cpuModels.every((m) => ev.models[modelKey(m)] === true)) {
    return cpuModels.length === 1 ? `${cpuModels[0].name} sets num_gpu 0 in its Modelfile` : "Every model on the CPU sets num_gpu 0 in its Modelfile";
  }
  return null;
}

/** CUDA_VISIBLE_DEVICES takes indexes and (prefixes of) UUIDs. */
function namesAGpu(value: string, gpus: GpuStats[]): boolean {
  return value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((id) =>
    id.startsWith("mig-") || gpus.some((g) => String(g.index) === id || (id.length >= 5 && g.uuid.toLowerCase().startsWith(id))));
}

/** Likely causes, likeliest first, and the fixes for them. Restarting Ollama always comes last. */
function explain(ev: GpuEvidence | null, current: boolean, gpus: GpuStats[], cpuModels: PsModel[]): { causes: string[]; fixes: GpuFix[] } {
  const causes: string[] = [];
  const fixes: GpuFix[] = [];
  const fix = (f: GpuFix) => {
    if (!fixes.some((x) => x.label === f.label)) fixes.push(f);
  };
  const facts = ev?.facts;
  const linux = ev?.platform === "linux";
  const uvm = linux && ev?.uvm?.driver ? ev.uvm : null;
  const where = uvm?.container ? "on the host that runs this container (on Proxmox, the Proxmox host)" : "on this host";
  const reload: GpuFix | null = uvm?.can_reload ? {
    action: "reload_uvm", label: "Reload nvidia_uvm and restart Ollama",
    detail: "Stops Ollama, reloads the nvidia_uvm kernel module and starts Ollama again. It fails while another program uses CUDA.",
  } : null;

  if (facts?.no_avx) {
    causes.push("Ollama turned the GPU off because the CPU lacks the AVX instructions it wants. In a VM, the CPU type often hides them.");
    fix({
      action: null, label: "Give the VM the host's CPU type",
      detail: "On Proxmox: Hardware → Processors → Type: host, then restart the VM. Or update Ollama: newer versions use the GPU without AVX.",
    });
  }
  if (uvm && !uvm.module) {
    causes.push("The nvidia_uvm kernel module isn't loaded, and CUDA needs it.");
    fix(reload ?? { action: null, label: `Load nvidia_uvm ${where}`, detail: `Then restart ${uvm.container ? "the container" : "Ollama"}.`, command: "modprobe nvidia_uvm && nvidia-modprobe -u -c=0" });
  } else if (uvm && !uvm.device) {
    causes.push(uvm.container
      ? "/dev/nvidia-uvm is missing in this container. The host creates it when something first uses CUDA there, which after a host reboot may not have happened before the container started."
      : "/dev/nvidia-uvm is missing, so CUDA can't reach the GPU.");
    fix(reload ?? { action: null, label: `Create /dev/nvidia-uvm ${where}`, detail: `Then restart ${uvm.container ? "the container, so it gets the device" : "Ollama"}.`, command: "nvidia-modprobe -u -c=0" });
  }
  if (facts?.mismatch) {
    causes.push("The NVIDIA driver was updated, but the old kernel module is still loaded, so the driver's libraries and module don't match.");
    fix({ action: null, label: uvm?.container ? "Reboot the host that runs this container" : "Reboot the host", detail: "The reboot loads the new driver's kernel module." });
  }
  if (facts?.code999) {
    causes.push(linux
      ? "CUDA failed with error 999. This usually follows a suspend and resume, after which nvidia_uvm has lost the device."
      : "CUDA failed with error 999. This usually follows a sleep and resume or a driver update.");
    if (reload) fix(reload);
    else if (uvm) {
      fix({
        action: null, label: `Reload nvidia_uvm ${where}`, command: "rmmod nvidia_uvm && modprobe nvidia_uvm",
        detail: `Stop the programs that use CUDA first, then restart ${uvm.container ? "the container" : "Ollama"}.`,
      });
    }
  }
  const cvd = ev?.env.CUDA_VISIBLE_DEVICES;
  if (cvd !== undefined && !namesAGpu(cvd, gpus)) {
    causes.push(`CUDA_VISIBLE_DEVICES=${cvd || '""'} names none of the GPUs nvidia-smi sees, so CUDA hides all of them from Ollama.`);
    fix({ action: null, label: "Correct CUDA_VISIBLE_DEVICES in the Environment tab", detail: `Use GPU indexes (${gpus.map((g) => g.index).join(", ")}) or UUIDs, or remove it to use every GPU.` });
  }
  if (facts?.amd) {
    causes.push("Ollama's log shows an AMD GPU as well. With both, Ollama can pick the AMD GPU or fail on it instead of using the NVIDIA one.");
    fix({ action: null, label: "Hide the AMD GPU in the Environment tab", detail: "Set ROCR_VISIBLE_DEVICES=-1 and HIP_VISIBLE_DEVICES=-1, then restart Ollama." });
  }
  if (!causes.length && facts) {
    if (facts.found === false || facts.errors.length) {
      causes.push("Ollama couldn't use the GPU when it last looked for one. Common reasons: Ollama started before the driver was ready, or the driver or Ollama was updated.");
    } else if (cpuModels.length && current) {
      const free = gpus.reduce((s, g) => s + Math.max(0, (g.mem_total_mib ?? 0) - (g.mem_used_mib ?? 0)), 0) * 1024 ** 2;
      const need = Math.min(...cpuModels.map((m) => m.size));
      causes.push(free < need
        ? `The GPUs have ${fmtGB(free)} free, less than the ${fmtGB(need)} the model needs: other programs or models hold the VRAM.`
        : "Ollama's log shows no GPU error. A client may have asked for num_gpu 0 in its request options, or the VRAM was full when the model loaded.");
    }
  }
  fix({ action: "restart", label: "Restart Ollama", detail: "Ollama looks for GPUs again when it starts. Loaded models are unloaded." });
  return { causes, fixes };
}
