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
export type AlertKind = "gpu_temp" | "vram" | "disk" | "host_unreachable" | "agent_unreachable" | "ollama_crash" | "gpu_lost";

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
  kind: "pull" | "create";
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
