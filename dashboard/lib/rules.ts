// Alert rule kinds, shared by the server (validation, defaults) and the rule editor.
import type { AlertKind, AlertRule } from "./types";

export interface KindInfo {
  label: string;
  /** the threshold's unit; null: the kind has no threshold */
  unit: "°C" | "%" | "loads/h" | null;
  threshold: number | null;
  /** the highest threshold allowed; default 100 for percentages and 150 otherwise */
  max?: number;
  for_s: number;
  help: string;
}

export const ALERT_KINDS: Record<AlertKind, KindInfo> = {
  gpu_temp: {
    label: "GPU temperature", unit: "°C", threshold: 85, for_s: 120,
    help: "A GPU is hotter than the threshold. Needs the agent.",
  },
  vram: {
    label: "VRAM usage", unit: "%", threshold: 95, for_s: 300,
    help: "A GPU's memory is fuller than the threshold. Ollama fills VRAM on purpose, so this suits hosts where that's unexpected. Needs the agent.",
  },
  disk: {
    label: "Disk nearly full", unit: "%", threshold: 90, for_s: 300,
    help: "A filesystem the agent reports, including the one holding OLLAMA_MODELS, is fuller than the threshold. Needs the agent.",
  },
  host_unreachable: {
    label: "Host unreachable", unit: null, threshold: null, for_s: 60,
    help: "Neither Ollama nor the agent answers (Ollama alone for a host without an agent).",
  },
  agent_unreachable: {
    label: "Agent unreachable", unit: null, threshold: null, for_s: 120,
    help: "The agent doesn't answer, or refuses the token or key, while Ollama does.",
  },
  ollama_crash: {
    label: "Ollama crashed or restarted", unit: null, threshold: null, for_s: 30,
    help: "Ollama's API is down while the agent answers, or the agent saw Ollama restart or a model's runner exit. Restarts and runner exits fire at once; restarts from the dashboard don't count. Needs the agent.",
  },
  gpu_lost: {
    label: "Ollama lost the GPU", unit: null, threshold: null, for_s: 60,
    help: "nvidia-smi sees a GPU, but the loaded models run entirely on the CPU, or Ollama's log shows it found no GPU or hit GPU errors. Settings that ask for the CPU (CUDA_VISIBLE_DEVICES=-1, num_gpu 0) don't count. Needs the agent.",
  },
  context_short: {
    label: "Context below configured", unit: null, threshold: null, for_s: 60,
    help: "A loaded model has less context allocated than the host sets (num_ctx in its Modelfile, or OLLAMA_CONTEXT_LENGTH). This does not prove a client override or prompt truncation. Each model has its own alert. OLLAMA_CONTEXT_LENGTH needs the agent.",
  },
  reload_churn: {
    label: "Model reloading constantly", unit: "loads/h", threshold: 10, max: 10000, for_s: 0,
    help: "A model was loaded more often than the threshold in the last hour. Each model has its own alert. With the agent, loads too short for a poll to see are counted from Ollama's log as well.",
  },
  insecure: {
    label: "Security check failing", unit: null, threshold: null, for_s: 60,
    help: "A check on the Security page fails: Ollama answering without a key, an agent over plain HTTP or with a weak token, and, when the rule covers every host, the dashboard's own checks. Each check has its own alert; dismissed checks don't count.",
  },
};

export const isAlertKind = (k: unknown): k is AlertKind => typeof k === "string" && Object.hasOwn(ALERT_KINDS, k);

export const DEFAULT_CLEAR_S = 60;

/** The rules a new install starts with, until the first edit writes alert-rules.json. */
export const DEFAULT_RULES: AlertRule[] = (
  [
    ["gpu-temp", "gpu_temp", true],
    // off by default: Ollama keeps models in VRAM, so a full GPU is usually intended
    ["vram", "vram", false],
    ["disk", "disk", true],
    ["host-unreachable", "host_unreachable", true],
    ["agent-unreachable", "agent_unreachable", true],
    ["ollama-crash", "ollama_crash", true],
    ["gpu-lost", "gpu_lost", true],
    // off by default: a client may ask for a small context on purpose
    ["context-short", "context_short", false],
    ["reload-churn", "reload_churn", true],
    ["insecure", "insecure", true],
  ] as const
).map(([id, kind, enabled]) => ({
  id, name: ALERT_KINDS[kind].label, kind, enabled,
  threshold: ALERT_KINDS[kind].threshold, for_s: ALERT_KINDS[kind].for_s, clear_s: DEFAULT_CLEAR_S, hosts: null, channels: null,
}));

/** "for 2m" style text for a rule's duration. */
export function durText(s: number): string {
  if (s === 0) return "at once";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return [h && `${h}h`, m && `${m}m`, r && `${r}s`].filter(Boolean).join(" ");
}

/** "90", "90s", "2m", "1h 30m" → seconds; null if it can't be read. */
export function parseDur(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  let total = 0;
  const rest = s.replace(/(\d+(?:\.\d+)?)\s*(h|m|s)\s*/g, (_, n: string, u: string) => {
    total += Number(n) * { h: 3600, m: 60, s: 1 }[u as "h" | "m" | "s"];
    return "";
  });
  return rest ? null : Math.round(total);
}

/** "85°C", "90%", "10 loads/h". */
export const thresholdText = (value: number | null, unit: KindInfo["unit"]) => `${value}${unit && /^[a-z]/i.test(unit) ? " " : ""}${unit ?? ""}`;

/** "GPU0", a disk's path, a model's name, a security check, or "" for the host itself. */
export const subjectText = (subject: string) =>
  Object.hasOwn(SECURITY_SUBJECTS, subject) ? SECURITY_SUBJECTS[subject] : subject.replace(/^gpu(\d+)$/, "GPU$1");

/** The security checks' ids as alert subjects (lib/security.ts has the same labels). */
const SECURITY_SUBJECTS: Record<string, string> = {
  ollama_open: "Ollama without a key", agent_http: "agent over HTTP", agent_token: "agent token",
  default_password: "initial password", dashboard_http: "dashboard over HTTP", data_files: "data file modes", api_tokens: "API token expiry",
};
