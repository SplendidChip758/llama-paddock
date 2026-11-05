// Shapes shared between the server (route handlers) and the browser.

export interface GpuStats {
  index: number;
  uuid: string;
  name: string;
  driver: string;
  pstate: string;
  temp_c: number | null;
  fan_pct: number | null;
  util_pct: number | null;
  mem_util_pct: number | null;
  mem_used_mib: number | null;
  mem_total_mib: number | null;
  power_w: number | null;
  power_limit_w: number | null;
  sm_clock_mhz: number | null;
  sm_clock_max_mhz: number | null;
  mem_clock_mhz: number | null;
  pcie_gen: number | null;
  pcie_width: number | null;
}

export interface GpuProcess {
  gpu_uuid: string;
  pid: number | null;
  name: string;
  mem_mib: number | null;
}

export interface SystemStats {
  hostname: string;
  uptime_s: number;
  cpu_count: number;
  cpu_pct: number;
  cpu_per_core: number[];
  load: number[];
  mem: { total: number; used: number; available: number; pct: number };
  swap: { total: number; used: number; pct: number };
  disks: { path: string; total: number; used: number; free: number; pct: number }[];
  net: { rx_bps: number | null; tx_bps: number | null };
  ollama_process: { pid: number; rss_total: number; runners: number } | null;
}

export interface ServiceStatus {
  active: string | null;
  sub?: string | null;
  since: string | null;
  main_pid: number | null;
  restarts?: string | null;
}

export type Platform = "linux" | "windows";

export interface AgentStats {
  ts: number;
  /** missing before 0.6.0; the dashboard then asks /health instead */
  version?: string;
  platform?: Platform;
  /** SHA-256 of the agent's TLS key (agents from 0.7.0 on), missing when it can't serve HTTPS */
  fingerprint?: string | null;
  system: SystemStats;
  nvidia: { available: boolean; error?: string; gpus: GpuStats[]; processes: GpuProcess[] };
  service: ServiceStatus;
}

export interface ModelDetails {
  parent_model?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

export interface PsModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  digest: string;
  details?: ModelDetails;
  expires_at?: string;
  context_length?: number;
}

/** See modelSplit() in lib/split.ts. */
export interface ModelSplit {
  /** gpu: all in VRAM · partial: some in system RAM, run by the CPU · cpu: none in VRAM ·
   *  cloud: runs remotely · unknown: Ollama didn't report usable sizes */
  state: "gpu" | "partial" | "cpu" | "cloud" | "unknown";
  /** share of the model in VRAM, 0–100; null for cloud and unknown */
  gpu_pct: number | null;
  /** bytes in system RAM; null for cloud and unknown */
  cpu_bytes: number | null;
}

/** An /api/ps entry as the dashboard serves it. */
export interface LoadedModel extends PsModel {
  split: ModelSplit;
  /** missing until the dashboard has read the model's /api/show */
  context?: ContextCheck;
}

/** The context a loaded model runs with against what the host sets; see contextCheck() in lib/modelcheck.ts. */
export interface ContextCheck {
  /** tokens, from /api/ps */
  running: number | null;
  /** the most the model supports, from /api/show */
  max: number | null;
  /** what the host sets when a client doesn't: num_ctx in the Modelfile, else OLLAMA_CONTEXT_LENGTH */
  configured: number | null;
  configured_by: "modelfile" | "env" | null;
  /** short: below what the host sets, without proof of the cause · default: nothing sets more,
   *  and the model supports far more · ok · unknown: Ollama doesn't report the running context */
  state: "ok" | "short" | "default" | "unknown";
  /** what it means and what to change; null when ok */
  hint: string | null;
}

/** A model loaded again and again; see reloadChurn() in lib/modelcheck.ts. */
export interface ReloadChurn {
  /** null: loads Ollama's log shows that the polls never saw, so their model isn't known */
  model: string | null;
  /** in the last hour */
  loads: number;
  summary: string;
  causes: string[];
  fixes: string[];
}

export interface TagModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: ModelDetails;
  /** cloud models: the model and host Ollama forwards requests to */
  remote_model?: string;
  remote_host?: string;
  /** added by the dashboard: see isCloudModel() */
  cloud?: boolean;
}

export interface InstanceSnapshot {
  id: string;
  name: string;
  tags: string[];
  ollama_url: string;
  agent_url: string | null;
  has_agent: boolean;
  has_token: boolean;
  /** https:// agents: the pinned key, SHA256:<base64>. null until the first connection pins it. */
  agent_fingerprint: string | null;
  /** The pin comes from config.yaml, so it can only be changed there. */
  agent_fingerprint_in_config: boolean;
  /** The key the agent presented instead of the pinned one. The dashboard stops calling the agent until it is accepted. */
  agent_key_changed: string | null;
  /** The key an http:// agent reports: it can serve HTTPS, and this is what to pin when switching. */
  agent_https_fingerprint: string | null;
  /** A key for the proxy in front of Ollama is stored. The key itself never leaves the server. */
  has_ollama_proxy_key: boolean;
  /** "config": from config.yaml (read-only here); "ui": added in the dashboard. */
  source: "config" | "ui";
  ollama_ok: boolean;
  ollama_error: string | null;
  agent_ok: boolean;
  agent_error: string | null;
  version: string | null;
  agent_version: string | null;
  ps: LoadedModel[];
  stats: AgentStats | null;
  /** whether Ollama uses the GPU nvidia-smi sees; null without an agent, an NVIDIA GPU or Ollama answering */
  gpu_check: GpuCheck | null;
  /** models loaded at least RELOAD_WARN_LOADS times in the last hour */
  reload_churn: ReloadChurn[];
  updated: number | null;
}

/** The agent's GET /gpu-check (agents from 0.8.0): evidence for the GPU check, read when the dashboard asks. */
export interface AgentGpuCheck {
  ts: number;
  platform?: Platform;
  /** GPU-related lines from Ollama's log since it last started */
  log: { source: "journal" | "server.log"; lines: string[]; error?: string };
  /** Linux: the NVIDIA kernel modules. In a container they belong to the host, so can_reload is false there. */
  nvidia_uvm?: { driver: boolean; module: boolean; device: boolean; container: boolean; can_reload: boolean };
}

export type GpuFixAction = "restart" | "reload_uvm";

export interface GpuFix {
  /** a fix the dashboard runs through the agent; null for a command to run by hand */
  action: GpuFixAction | null;
  label: string;
  detail: string;
  command?: string;
}

/** See diagnoseGpu() in lib/gpucheck.ts. */
export interface GpuCheck {
  /** ok: Ollama uses the GPU · lost: a GPU is present, but Ollama runs on the CPU or failed to use it ·
   *  cpu_intended: on the CPU because a setting says so · unknown: nothing loaded, and the log doesn't tell */
  state: "ok" | "lost" | "cpu_intended" | "unknown";
  summary: string;
  /** likely causes, the likeliest first; lost only */
  causes: string[];
  fixes: GpuFix[];
  /** what the result rests on, as sentences */
  evidence: string[];
  /** the lines of Ollama's log since its last start that the result rests on */
  log_lines: string[];
  /** when Ollama's log and settings were read; null: not yet in this run of Ollama, so only /api/ps counts */
  checked_at: number | null;
  /** what limited the check, such as an older agent or an unreadable log */
  notes: string[];
}

export interface HistoryPoint {
  t: number;
  cpu?: number;
  mem?: number;
  /** network throughput, bytes/s */
  rx?: number;
  tx?: number;
  gpus?: { u: number | null; m: number | null; mt: number | null; t: number | null; p: number | null }[];
  vram: number;
  loaded: number;
}

/**
 * A change the poller observed. Polls are periodic, so `t` is when a change was first seen, not
 * when it happened: a model loaded and unloaded between two polls leaves no event at all.
 */
export interface HostEvent {
  instance: string;
  t: number;
  /** ollama / agent: reachability changed (up). load / unload: a model appeared in or left /api/ps. */
  kind: "ollama" | "agent" | "load" | "unload";
  /** the first observation after a time in which this was unknown (a dashboard restart, a gap in polling, or Ollama
   *  unreachable for model events), so it began at or before t */
  first: boolean;
  up?: boolean;
  /** why ollama or agent is down */
  error?: string;
  model?: string;
  digest?: string;
  context_length?: number;
  size_vram?: number;
}

/** What an alert rule watches; see lib/rules.ts for each kind's unit and defaults. */
export type AlertKind = "gpu_temp" | "vram" | "disk" | "host_unreachable" | "agent_unreachable" | "ollama_crash" | "gpu_lost" | "context_short" | "reload_churn";

export interface AlertRule {
  id: string;
  name: string;
  kind: AlertKind;
  enabled: boolean;
  /** °C for gpu_temp, percent for vram and disk; null for the kinds without one */
  threshold: number | null;
  /** seconds the condition must be observed without a break before the alert fires */
  for_s: number;
  /** seconds the condition must be observed clear without a break before a firing alert resolves */
  clear_s: number;
  /** host ids, or null for every host, including ones added later */
  hosts: string[] | null;
  /** notification channel ids, or null for every channel, including ones added later. Missing before 0.8.0: every channel */
  channels?: string[] | null;
}

/**
 * One rule's alert on one host. `subject` tells apart several on a host: "gpu0" for a GPU, the path
 * for a disk, "" for the host itself.
 */
export interface ActiveAlert {
  rule: string;
  name: string;
  kind: AlertKind;
  instance: string;
  subject: string;
  /** pending: the condition holds, but not yet for the rule's for_s */
  state: "pending" | "firing";
  since: number;
  fired_at: number | null;
  value: number | null;
  detail: string;
  /** the last poll had no data for it (agent down, GPU gone, …), so it can neither fire nor resolve */
  unknown: boolean;
  /** fired repeatedly in a short time; it now has to stay clear longer before it resolves */
  flapping: boolean;
  /** a silence or acknowledgement that matches it: it still shows and is recorded, but isn't counted or sent */
  silence: AlertSilence | null;
}

/** One stretch of a timeline. unobserved: the dashboard wasn't polling; unknown: polled, but not yet seen either way. */
export interface AvailabilitySegment {
  start: number;
  end: number;
  state: "up" | "down" | "unknown" | "unobserved";
  /** down: why, as the poll that saw it go down reported */
  error?: string;
}

/** Ollama's or the agent's availability over a range. Only observed time counts: up_pct is up / (up + down). */
export interface Availability {
  up_pct: number | null;
  up_s: number;
  down_s: number;
  unknown_s: number;
  unobserved_s: number;
  segments: AvailabilitySegment[];
  /** the down segments, newest first; ongoing: still down at the last poll */
  outages: { start: number; end: number; error: string | null; ongoing: boolean }[];
}

export interface HostAvailability {
  range: string;
  from: number;
  to: number;
  /** share of the range the dashboard was polling the host */
  coverage: number;
  ollama: Availability;
  /** null for a host without an agent */
  agent: Availability | null;
}

/**
 * Alerts muted for a while. rule, instance and subject say what it matches; null matches anything,
 * so a silence with only `instance` covers a whole host (maintenance).
 */
export interface AlertSilence {
  id: number;
  created: number;
  rule: string | null;
  instance: string | null;
  subject: string | null;
  /** unix seconds; null for an acknowledgement */
  until: number | null;
  /** an acknowledgement: lasts until its alert resolves */
  until_resolved: boolean;
  note: string;
}

/** An alert starting or ending. Rule name and kind are copied, since rules can change later. */
export interface AlertTransition {
  id: number;
  t: number;
  rule: string;
  name: string;
  kind: AlertKind;
  instance: string;
  subject: string;
  state: "firing" | "resolved";
  value: number | null;
  detail: string;
  flapping: boolean;
}

/** One request from Ollama's log, as the agents' GET /requests returns it. */
export interface AgentRequest {
  /** when it finished, unix seconds */
  t: number;
  status: number;
  duration_ms: number;
  /** the client's IP address, as Ollama saw it */
  client: string;
  method: string;
  /** without the query string */
  path: string;
}

export interface RequestCount {
  count: number;
  /** answered with status 400 or above */
  errors: number;
  avg_ms: number;
  max_ms: number;
}

/** A host's request log over a range, from GET /api/instances/{id}/requests. */
export interface RequestSummary {
  range: string;
  from: number;
  to: number;
  /** seconds per bucket in `buckets` */
  bucket_s: number;
  total: RequestCount;
  buckets: { t: number; count: number; errors: number }[];
  /** `name`: what the client's address has been named, or null */
  clients: (RequestCount & { client: string; name: string | null; last: number })[];
  endpoints: (RequestCount & { method: string; path: string })[];
  /** requests matched to the one model that was loaded then; the rest are left out */
  models: (RequestCount & { model: string })[];
  slowest: (AgentRequest & { model: string | null })[];
  recent: (AgentRequest & { model: string | null })[];
  /** how collecting goes for this host: the last successful read, and the last error */
  sync: {
    last_ok: number | null;
    error: string | null;
    /** the agent is older than 0.8.0 and has no request log */
    unsupported: boolean;
    /** lines that looked like requests but couldn't be read, since the dashboard started */
    skipped: number;
  };
}

/** One page of a host's requests, from GET /api/instances/{id}/requests/log. */
export interface RequestLogPage {
  range: string;
  sort: "latest" | "slowest";
  from: number;
  to: number;
  offset: number;
  limit: number;
  /** requests in the range, on every page */
  total: number;
  requests: (AgentRequest & { model: string | null })[];
}

export type ChannelType = "webhook" | "discord" | "slack" | "email";

/** A notification channel as the API returns it. Secrets (URLs, tokens, passwords) never leave the server. */
export interface NotifyChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  /** also send a message when an alert resolves */
  send_resolved: boolean;
  /** webhook, discord, slack: the URL with everything after the host hidden */
  url_hint: string | null;
  /** webhook: a bearer token is set */
  has_token: boolean;
  email: {
    host: string;
    port: number;
    security: "tls" | "starttls" | "none";
    username: string | null;
    has_password: boolean;
    from: string;
    to: string[];
  } | null;
  status: ChannelStatus;
}

/** How deliveries to a channel have gone since the dashboard started. */
export interface ChannelStatus {
  last_ok: number | null;
  last_error: string | null;
  last_error_at: number | null;
  /** messages waiting to be sent, retries included */
  queued: number;
}

export type JobState ="running" | "done" | "error" | "cancelled";

export interface JobInfo {
  id: string;
  /** benchmark: completed and total count runs, not bytes */
  kind: "pull" | "create" | "benchmark";
  instance: string;
  model: string;
  detail: string;
  status: string;
  state: JobState;
  completed: number;
  total: number;
  error: string | null;
  started: number;
  finished: number | null;
}

export type ParamValue = string | number | boolean | string[];

export interface ShowResult {
  model: string;
  details: ModelDetails | null;
  capabilities: string[] | null;
  parameters: Record<string, ParamValue>;
  parameters_raw: string | null;
  system: string | null;
  template: string | null;
  native_context_length: number | null;
  architecture: string | null;
  parameter_count: number | null;
  modified_at: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** How fast a host answered one prompt. Times in milliseconds; null where Ollama didn't say. */
export interface PromptStats {
  /** from sending the request to the first token, measured by the dashboard: includes loading the model and reading the prompt */
  ttft_ms: number | null;
  /** from sending the request to the last line of the answer, measured by the dashboard */
  wall_ms: number;
  /** the rest are Ollama's own figures from the answer's final line */
  load_ms: number | null;
  prompt_tokens: number | null;
  prompt_ms: number | null;
  /** prompt evaluation rate, tokens per second */
  prompt_tps: number | null;
  tokens: number | null;
  eval_ms: number | null;
  /** generation rate, tokens per second */
  tps: number | null;
  total_ms: number | null;
  done_reason: string | null;
}

/** One line of the chat stream from POST /api/instances/{id}/chat. */
export type PromptEvent =
  | { type: "token"; content: string; thinking?: string }
  | { type: "done"; stats: PromptStats }
  | { type: "error"; detail: string };

// ============================================================================ benchmarks (#32)
/** short: a short question · long_context: reading a long prompt · long_generation: writing a long answer */
export type BenchCase = "short" | "long_context" | "long_generation";
/** cold: the model is unloaded before every run, so each run includes loading it · warm: it is loaded first */
export type BenchMode = "cold" | "warm";

/** What was asked for. With the prompt set version, it is what makes two benchmarks comparable. */
export interface BenchSpec {
  /** version of the built-in prompt set; results from different sets don't compare */
  set: string;
  cases: BenchCase[];
  repeat: number;
  mode: BenchMode;
  /** context sent as num_ctx with every run, so every host runs the model at the same size */
  num_ctx: number;
}

/** One timed answer. */
export interface BenchRun {
  case: BenchCase;
  /** 1-based repetition */
  rep: number;
  t: number;
  /** whether the model was loaded at this context just before the run, as /api/ps showed it */
  state: BenchMode;
  stats: PromptStats;
  /** the model's entry in /api/ps right after the run; null when it wasn't listed */
  size: number | null;
  size_vram: number | null;
  split: ModelSplit | null;
  context: number | null;
}

/** The host and model a benchmark ran on. null: not known, e.g. no agent to ask. */
export interface BenchConditions {
  digest: string | null;
  quantization: string | null;
  parameter_size: string | null;
  family: string | null;
  format: string | null;
  ollama_version: string | null;
  agent_version: string | null;
  dashboard_version: string;
  platform: Platform | null;
  /** the context Ollama loaded the model with, from /api/ps */
  context: number | null;
  /** Ollama settings that change speed or memory use; unset ones are left out. null without an agent */
  env: Record<string, string> | null;
  gpus: { name: string; mem_total_mib: number | null; driver: string }[] | null;
  cpu_count: number | null;
  mem_total: number | null;
  /** other models loaded when it started: they share VRAM with the benchmarked one */
  other_models: string[];
}

export interface BenchStat {
  median: number;
  min: number;
  max: number;
  /** coefficient of variation in percent (standard deviation / mean); null with fewer than two runs */
  cv: number | null;
}

/** One case over all of its runs in the benchmark's mode. */
export interface BenchCaseSummary {
  case: BenchCase;
  runs: number;
  /** runs left out because the model wasn't in the state the mode asks for (e.g. something unloaded it) */
  excluded: number;
  tps: BenchStat | null;
  prompt_tps: BenchStat | null;
  ttft_ms: BenchStat | null;
  load_ms: BenchStat | null;
  prompt_tokens: number | null;
  tokens: number | null;
  /** the most VRAM the model used, and its split in the last run */
  size_vram: number | null;
  split: ModelSplit | null;
}

export interface BenchmarkInfo {
  id: string;
  /** benchmarks started together on several hosts share a batch */
  batch: string;
  instance: string;
  /** the host's name when it ran, kept after the host is renamed or removed */
  instance_name: string;
  model: string;
  state: JobState;
  error: string | null;
  started: number;
  finished: number | null;
  spec: BenchSpec;
  conditions: BenchConditions | null;
  summary: BenchCaseSummary[];
  /** things that make the figures less comparable */
  warnings: string[];
  /** only in GET /api/benchmarks/{bid} */
  runs?: BenchRun[];
}

export interface EnvState {
  platform?: Platform;
  managed: Record<string, string>;
  override_path: string;
  raw: string;
  effective: Record<string, string>;
  external: Record<string, string>;
  /** Names the agent lets the dashboard set (a trailing * allows a prefix). Agents before 0.6.0 accept any name. */
  allowed?: string[];
}

// ============================================================================ audit log
/** What the audit log records, grouped by the part before the dot (the Action filter's groups). */
export const AUDIT_ACTIONS = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.password": "Changed own password",
  "user.add": "Added user",
  "user.role": "Changed role",
  "user.reset": "Reset password",
  "user.remove": "Removed user",
  "token.create": "Created token",
  "token.revoke": "Revoked token",
  "host.add": "Added host",
  "host.edit": "Edited host",
  "host.remove": "Removed host",
  "host.agent_https": "Switched agent to HTTPS",
  "host.agent_key": "Accepted agent key",
  "ollama.restart": "Restarted Ollama",
  "ollama.gpu_fix": "Ran a GPU fix",
  "env.change": "Changed environment",
  "model.pull": "Pulled model",
  "model.create": "Created model",
  "model.copy": "Copied model",
  "model.delete": "Deleted model",
  "model.load": "Loaded model",
  "model.unload": "Unloaded model",
  "job.cancel": "Cancelled or cleared job",
  "alert.rules": "Changed alert rules",
  "alert.channels": "Changed alert channels",
  "alert.silence": "Silenced alerts",
  "alert.unsilence": "Ended a silence",
  "benchmark.start": "Started benchmark",
  "benchmark.cancel": "Cancelled benchmark",
  "benchmark.delete": "Deleted benchmark",
  "settings.client_names": "Renamed request clients",
} as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const AUDIT_GROUPS: Record<string, string> = {
  auth: "Sign-in", user: "Users", token: "API tokens", host: "Hosts", ollama: "Ollama service", env: "Environment",
  model: "Models", job: "Jobs", alert: "Alerts", benchmark: "Benchmarks", settings: "Settings",
};

/**
 * One audit record. Never holds prompts, passwords, tokens or environment values: only names,
 * which env keys changed and the like.
 */
export interface AuditEntry {
  id: number;
  /** unix seconds */
  t: number;
  /** who: null when the login is off (PADDOCK_AUTH=off) or a failed sign-in names no account */
  user: string | null;
  /** the API token the request came with, by name and id; null for a browser session */
  credential: string | null;
  credential_id: string | null;
  /** the client address, as the brute-force guard sees it */
  ip: string | null;
  action: AuditAction;
  /** host id and its name at the time, kept after the host is renamed or removed */
  instance: string | null;
  instance_name: string | null;
  /** what was acted on: a model, user, token, rule… */
  target: string | null;
  detail: string;
}

// ============================================================================ fit estimates
/** What a fit estimate needs to know about a model, from /api/show and /api/tags; see fitModel() in lib/fit.ts. */
export interface FitModel {
  name: string;
  digest: string | null;
  /** the model's files on disk (/api/tags size): weights, plus a projector for vision models. null when it isn't pulled */
  weights: number | null;
  architecture: string | null;
  /** the context it was trained for */
  max_context: number | null;
  layers: number | null;
  /** KV heads per layer; models can vary them, and layers without attention have 0 */
  kv_heads: number[] | null;
  heads: number | null;
  key_length: number | null;
  value_length: number | null;
  embedding: number | null;
  vocab: number | null;
  /** sliding-window attention: the window, and how many layers use it (null: not known for this architecture) */
  sliding: { window: number; layers: number | null } | null;
  /** has state-space (recurrent) layers, whose memory doesn't follow the KV cache formula */
  recurrent: boolean;
  /** Modelfile parameters that change the estimate */
  num_ctx: number | null;
  num_gpu: number | null;
  num_batch: number | null;
  /** an Ollama cloud model: nothing runs on the host */
  cloud: boolean;
}

/** What a fit estimate needs to know about a host; see fitHost() in lib/server.ts. */
export interface FitHost {
  id: string;
  name: string;
  /** bytes; other: VRAM held by processes other than Ollama. null: no agent stats, so the GPUs aren't known */
  gpus: { index: number; name: string; total: number; other: number }[] | null;
  /** bytes; available counts what Ollama's runners hold, since Ollama unloads models to make room */
  ram: { total: number; available: number } | null;
  /** Ollama's settings that change the estimate; null when the environment isn't known (no agent) */
  env: {
    kv_cache_type: string | null;
    flash_attention: boolean | null;
    num_parallel: number | null;
    context_length: number | null;
    gpu_overhead: number | null;
  } | null;
  /** other models loaded now */
  loaded: { name: string; size: number; size_vram: number }[];
}

/** What /api/ps reported for the model once loaded at a context, under the settings settingsKey() names. */
export interface FitMeasurement {
  instance: string;
  context: number;
  settings: string;
  size: number;
  size_vram: number;
  t: number;
}

export interface FitEstimate {
  instance: string;
  instance_name: string;
  /** tokens per request; the KV cache holds this times the parallel requests */
  context: number;
  context_source: "requested" | "modelfile" | "env" | "default";
  /** fits: likely fully in VRAM · offload: likely partly or fully on the CPU · insufficient: not enough VRAM and RAM ·
   *  unknown: insufficient information · cloud: runs remotely, nothing to estimate */
  verdict: "fits" | "offload" | "insufficient" | "unknown" | "cloud";
  confidence: "high" | "medium" | "low" | null;
  /** predicted bytes, as /api/ps would report the loaded model. total includes any calibration; the parts are the formula's */
  total: number | null;
  weights: number | null;
  kv: number | null;
  overhead: number | null;
  /** the formula alone, before calibration */
  formula_total: number | null;
  /** expected share in VRAM, 0–100 */
  gpu_pct: number | null;
  placement: string | null;
  /** VRAM the model could use on its GPU(s), bytes */
  capacity: number | null;
  /** the largest context likely to fit entirely in VRAM under the same assumptions; null when unknown */
  max_gpu_context: number | null;
  /** loaded models Ollama would unload to make room */
  evicts: string[];
  /** measured: /api/ps reported this context · fitted: a line through measurements at two or more contexts ·
   *  offset: the formula shifted by one measurement */
  calibration: { kind: "measured" | "fitted" | "offset"; points: { context: number; size: number }[] } | null;
  summary: string;
  assumptions: string[];
}

/** POST /api/instances/{id}/models/fit: the inputs, so the editor can estimate other contexts without asking again. */
export interface FitResult {
  model: FitModel;
  /** the requested host first */
  hosts: FitHost[];
  measurements: FitMeasurement[];
  estimates: FitEstimate[];
}
