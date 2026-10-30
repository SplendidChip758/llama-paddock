import "server-only";
import { version } from "@/package.json";
import { paddock } from "./server";

// Prometheus text exposition format 0.0.4, built from the poller's latest state (not the SQLite
// history), so a scrape costs no upstream calls. Units are Prometheus base units: bytes, seconds,
// hertz, watts, celsius, and ratios (0–1) instead of percent. Unknown values are left out, never NaN.

export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

type Labels = Record<string, string | number>;

const MIB = 1024 * 1024;
const MHZ = 1e6;

const escLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const escHelp = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

/** Samples grouped by metric family: the format wants each family's samples together. */
class Exposition {
  private families = new Map<string, { help: string; samples: string[] }>();

  gauge(name: string, help: string) {
    const fam = { help, samples: [] as string[] };
    this.families.set(name, fam);
    return (labels: Labels, value: number | null | undefined, scale = 1) => {
      if (value == null || !Number.isFinite(value)) return;
      const ls = Object.entries(labels).map(([k, v]) => `${k}="${escLabel(String(v))}"`).join(",");
      // toPrecision trims float noise such as 23.4 / 100 = 0.23399999999999999
      fam.samples.push(`${name}${ls ? `{${ls}}` : ""} ${Number((value * scale).toPrecision(15))}`);
    };
  }

  toString() {
    let out = "";
    for (const [name, f] of this.families) {
      out += `# HELP ${name} ${escHelp(f.help)}\n# TYPE ${name} gauge\n`;
      for (const s of f.samples) out += s + "\n";
    }
    return out;
  }
}

const ratio = (pct: number | null | undefined) => (pct == null ? null : pct / 100);

export function renderMetrics(): string {
  const x = new Exposition();
  const buildInfo = x.gauge("paddock_build_info", "llama-paddock dashboard version; always 1");
  const ollamaUp = x.gauge("paddock_ollama_up", "1 if the last poll of Ollama's API succeeded");
  const agentUp = x.gauge("paddock_agent_up", "1 if the last poll of the agent succeeded; only for hosts with an agent");
  const lastPoll = x.gauge("paddock_last_poll_timestamp_seconds", "Unix time of the last completed poll of the host");
  const ollamaInfo = x.gauge("paddock_ollama_info", "Ollama version reported by the host; always 1");
  const agentInfo = x.gauge("paddock_agent_info", "Agent version and platform; always 1");

  const loaded = x.gauge("paddock_ollama_loaded_models", "Models loaded in Ollama");
  const modelSize = x.gauge("paddock_ollama_model_size_bytes", "Memory used by a loaded model, VRAM plus system RAM");
  const modelVram = x.gauge("paddock_ollama_model_vram_bytes", "VRAM used by a loaded model");
  const modelCtx = x.gauge("paddock_ollama_model_context_length", "Context length a loaded model runs with, in tokens");
  const modelExpires = x.gauge("paddock_ollama_model_expires_timestamp_seconds", "Unix time when Ollama unloads an idle model");

  const gpuInfo = x.gauge("paddock_gpu_info", "GPU driver version; always 1");
  const gpuUtil = x.gauge("paddock_gpu_utilization_ratio", "GPU core utilization (0-1)");
  const gpuMemUtil = x.gauge("paddock_gpu_memory_utilization_ratio", "GPU memory controller utilization (0-1)");
  const gpuMemUsed = x.gauge("paddock_gpu_memory_used_bytes", "GPU memory in use");
  const gpuMemTotal = x.gauge("paddock_gpu_memory_total_bytes", "GPU memory size");
  const gpuTemp = x.gauge("paddock_gpu_temperature_celsius", "GPU core temperature");
  const gpuFan = x.gauge("paddock_gpu_fan_ratio", "GPU fan speed (0-1)");
  const gpuPower = x.gauge("paddock_gpu_power_watts", "GPU power draw");
  const gpuPowerLimit = x.gauge("paddock_gpu_power_limit_watts", "GPU power limit");
  const gpuSm = x.gauge("paddock_gpu_sm_clock_hertz", "GPU SM clock");
  const gpuSmMax = x.gauge("paddock_gpu_sm_clock_max_hertz", "GPU maximum SM clock");
  const gpuMemClock = x.gauge("paddock_gpu_memory_clock_hertz", "GPU memory clock");

  const cpuUtil = x.gauge("paddock_host_cpu_utilization_ratio", "Host CPU utilization over all cores (0-1)");
  const cpuCount = x.gauge("paddock_host_cpus", "Logical CPUs");
  const load1 = x.gauge("paddock_host_load1", "1-minute load average");
  const load5 = x.gauge("paddock_host_load5", "5-minute load average");
  const load15 = x.gauge("paddock_host_load15", "15-minute load average");
  const uptime = x.gauge("paddock_host_uptime_seconds", "Host uptime");
  const memTotal = x.gauge("paddock_host_memory_total_bytes", "Host RAM");
  const memUsed = x.gauge("paddock_host_memory_used_bytes", "Host RAM in use (total minus available)");
  const memAvail = x.gauge("paddock_host_memory_available_bytes", "Host RAM available");
  const swapTotal = x.gauge("paddock_host_swap_total_bytes", "Host swap size");
  const swapUsed = x.gauge("paddock_host_swap_used_bytes", "Host swap in use");
  const diskTotal = x.gauge("paddock_host_disk_total_bytes", "Filesystem size");
  const diskUsed = x.gauge("paddock_host_disk_used_bytes", "Filesystem space in use");
  const diskFree = x.gauge("paddock_host_disk_free_bytes", "Filesystem space available");
  const netRx = x.gauge("paddock_host_network_receive_bytes_per_second", "Network receive rate over all interfaces");
  const netTx = x.gauge("paddock_host_network_transmit_bytes_per_second", "Network transmit rate over all interfaces");
  const ollamaRss = x.gauge("paddock_ollama_process_resident_memory_bytes", "Resident memory of the Ollama server and its runners");
  const ollamaRunners = x.gauge("paddock_ollama_runners", "Ollama runner processes");

  buildInfo({ version }, 1);

  for (const st of paddock().instances.values()) {
    // not polled yet since the dashboard started: report nothing rather than a false "down"
    if (st.updated == null) continue;
    const host = { instance: st.inst.id, name: st.inst.name };

    ollamaUp(host, st.ollama_ok ? 1 : 0);
    lastPoll(host, st.updated);
    if (st.version) ollamaInfo({ ...host, version: st.version }, 1);
    // ps is emptied when Ollama is down, so there are no stale model series
    if (st.ollama_ok) loaded(host, st.ps.length);
    for (const m of st.ps) {
      const ml = { ...host, model: m.name };
      modelSize(ml, m.size);
      modelVram(ml, m.size_vram);
      modelCtx(ml, m.context_length);
      const exp = m.expires_at ? Date.parse(m.expires_at) / 1000 : null;
      modelExpires(ml, exp);
    }

    if (!st.inst.agent_url) continue;
    agentUp(host, st.agent_ok ? 1 : 0);
    if (st.agent_version) agentInfo({ ...host, version: st.agent_version, platform: st.stats?.platform ?? "linux" }, 1);
    // the poller keeps the last stats when the agent stops answering; don't present them as current
    if (!st.agent_ok || !st.stats) continue;

    const s = st.stats.system;
    cpuUtil(host, ratio(s.cpu_pct));
    cpuCount(host, s.cpu_count);
    // Windows has no load average; its agent sends zeros
    if (st.stats.platform !== "windows") {
      load1(host, s.load?.[0]);
      load5(host, s.load?.[1]);
      load15(host, s.load?.[2]);
    }
    uptime(host, s.uptime_s);
    memTotal(host, s.mem?.total);
    memUsed(host, s.mem?.used);
    memAvail(host, s.mem?.available);
    swapTotal(host, s.swap?.total);
    swapUsed(host, s.swap?.used);
    for (const d of s.disks ?? []) {
      const dl = { ...host, path: d.path };
      diskTotal(dl, d.total);
      diskUsed(dl, d.used);
      diskFree(dl, d.free);
    }
    netRx(host, s.net?.rx_bps);
    netTx(host, s.net?.tx_bps);
    ollamaRss(host, s.ollama_process?.rss_total);
    ollamaRunners(host, s.ollama_process?.runners);

    for (const g of st.stats.nvidia?.gpus ?? []) {
      const gl = { ...host, gpu: g.index, uuid: g.uuid, gpu_name: g.name };
      if (g.driver) gpuInfo({ ...gl, driver: g.driver }, 1);
      gpuUtil(gl, ratio(g.util_pct));
      gpuMemUtil(gl, ratio(g.mem_util_pct));
      gpuMemUsed(gl, g.mem_used_mib, MIB);
      gpuMemTotal(gl, g.mem_total_mib, MIB);
      gpuTemp(gl, g.temp_c);
      gpuFan(gl, ratio(g.fan_pct));
      gpuPower(gl, g.power_w);
      gpuPowerLimit(gl, g.power_limit_w);
      gpuSm(gl, g.sm_clock_mhz, MHZ);
      gpuSmMax(gl, g.sm_clock_max_mhz, MHZ);
      gpuMemClock(gl, g.mem_clock_mhz, MHZ);
    }
  }
  return x.toString();
}
