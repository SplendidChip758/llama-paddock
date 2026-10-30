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

export interface TagModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: ModelDetails;
}

export interface InstanceSnapshot {
  id: string;
  name: string;
  tags: string[];
  ollama_url: string;
  agent_url: string | null;
  has_agent: boolean;
  has_token: boolean;
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
  ps: PsModel[];
  stats: AgentStats | null;
  updated: number | null;
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
