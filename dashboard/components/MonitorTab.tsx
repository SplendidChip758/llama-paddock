"use client";

import { useEffect, useState } from "react";
import { api, fmtBytes, fmtDur, fmtMiB, fmtNum, instPath, level, pct, untilText } from "@/lib/format";
import type { GpuProcess, GpuStats, HistoryPoint, InstanceSnapshot, ServiceStatus, SystemStats } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Meter, SparkCell, Stat } from "./ui";

export function MonitorTab({ st }: { st: InstanceSnapshot }) {
  const [hist, setHist] = useState<HistoryPoint[]>([]);
  useEffect(() => {
    api<{ points: HistoryPoint[] }>(instPath(st.id, "/history")).then((d) => setHist(d.points)).catch(() => {});
  }, [st.id, st.updated]);

  const nv = st.stats?.nvidia;
  const sys = st.stats?.system;
  return (
    <>
      <h2 style={{ marginBottom: 12 }}>
        Loaded models <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>· ollama ps</span>
      </h2>
      <div className="card">
        <PsTable st={st} />
      </div>
      <div className="section">
        <h2>
          GPUs <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>· nvidia-smi</span>
        </h2>
        {!st.has_agent ? (
          <div className="notice">No agent configured for this instance — install the llama-paddock agent on the host for GPU and system metrics.</div>
        ) : nv && !nv.available ? (
          <div className="notice warn">nvidia-smi: {nv.error}</div>
        ) : nv ? (
          <div className="grid g2">
            {nv.gpus.map((g, i) => <GpuCard key={g.uuid} g={g} gi={i} hist={hist} procs={nv.processes} />)}
          </div>
        ) : null}
      </div>
      {sys && st.stats && (
        <div className="section">
          <h2>System</h2>
          <SystemCards sys={sys} hist={hist} svc={st.stats.service} />
        </div>
      )}
    </>
  );
}

function PsTable({ st }: { st: InstanceSnapshot }) {
  const { toast } = usePaddock();
  const [busy, setBusy] = useState<string | null>(null);
  if (!st.ollama_ok) return <div className="empty">Ollama is unreachable</div>;
  if (!st.ps.length) return <div className="empty">No models loaded</div>;

  const unload = async (model: string) => {
    setBusy(model);
    try {
      await api(instPath(st.id, "/models/unload"), { method: "POST", body: { model } });
      toast(`Unloaded ${model}`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            <th>Model</th><th>Params</th><th>Quant</th><th className="r">Context</th><th className="r">Size</th>
            <th style={{ minWidth: 180 }}>Processor</th><th>Unloads</th><th />
          </tr>
        </thead>
        <tbody>
          {st.ps.map((m) => {
            const gp = pct(m.size_vram, m.size);
            const proc = gp >= 99.5 ? "100% GPU" : gp <= 0.5 ? "100% CPU" : `${(100 - gp).toFixed(0)}% CPU / ${gp.toFixed(0)}% GPU`;
            return (
              <tr key={m.name}>
                <td><span className="name">{m.name}</span></td>
                <td>{m.details?.parameter_size ?? "–"}</td>
                <td>{m.details?.quantization_level ?? "–"}</td>
                <td className="r num">{fmtNum(m.context_length)}</td>
                <td className="r num">{fmtBytes(m.size)}</td>
                <td>
                  <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>{proc} · {fmtBytes(m.size_vram)} VRAM</div>
                  <div className="bar split">
                    <i style={{ width: `${gp}%` }} />
                    <i className="cpu" style={{ width: `${100 - gp}%` }} />
                  </div>
                </td>
                <td className="num">{untilText(m.expires_at)}</td>
                <td className="r">
                  <button className="btn sm" disabled={busy === m.name} onClick={() => unload(m.name)}>Unload</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GpuCard({ g, gi, hist, procs }: { g: GpuStats; gi: number; hist: HistoryPoint[]; procs: GpuProcess[] }) {
  const mp = pct(g.mem_used_mib, g.mem_total_mib);
  const series = (k: "u" | "m" | "t" | "p") => hist.map((p) => p.gpus?.[gi]?.[k] ?? null);
  const mine = procs.filter((p) => p.gpu_uuid === g.uuid);
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>GPU{g.index} · {g.name}</h3>
          <div className="faint" style={{ fontSize: 12 }}>
            driver {g.driver} · {g.pstate} · PCIe gen{g.pcie_gen ?? "?"} x{g.pcie_width ?? "?"}
          </div>
        </div>
        <span className={`chip ${(g.temp_c ?? 0) >= 85 ? "bad" : ""}`}>{g.temp_c ?? "–"}°C</span>
      </div>
      <Meter label="Utilization" value={`${g.util_pct ?? 0}%`} p={g.util_pct ?? 0} cls="" />
      <Meter label="VRAM" value={`${fmtMiB(g.mem_used_mib)} / ${fmtMiB(g.mem_total_mib)} (${mp.toFixed(0)}%)`} p={mp} />
      {g.power_w != null && <Meter label="Power" value={`${g.power_w.toFixed(0)} W / ${g.power_limit_w ?? "–"} W`} p={pct(g.power_w, g.power_limit_w)} cls="" />}
      <div className="stats" style={{ marginTop: 12 }}>
        <Stat k="SM clock" v={g.sm_clock_mhz ?? "–"} unit={`/ ${g.sm_clock_max_mhz ?? "–"} MHz`} />
        <Stat k="Mem clock" v={g.mem_clock_mhz ?? "–"} unit="MHz" />
        <Stat k="Fan" v={g.fan_pct ?? "–"} unit={g.fan_pct != null ? "%" : "passive"} />
        <Stat k="Mem bus" v={g.mem_util_pct ?? "–"} unit="%" />
      </div>
      <div className="sparkrow">
        <SparkCell label="Util" value={`${g.util_pct ?? 0}%`} values={series("u")} max={100} />
        <SparkCell label="VRAM" value={fmtMiB(g.mem_used_mib)} values={series("m")} max={g.mem_total_mib} />
        <SparkCell label="Temp" value={`${g.temp_c ?? "–"}°C`} values={series("t")} max={100} />
        <SparkCell label="Power" value={`${g.power_w != null ? g.power_w.toFixed(0) : "–"} W`} values={series("p")} max={g.power_limit_w} />
      </div>
      {mine.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>PID</th><th>Process</th><th className="r">VRAM</th></tr></thead>
            <tbody>
              {mine.map((p) => (
                <tr key={`${p.pid}`}>
                  <td className="num">{p.pid}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{p.name}</td>
                  <td className="r num">{fmtMiB(p.mem_mib)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SystemCards({ sys, hist, svc }: { sys: SystemStats; hist: HistoryPoint[]; svc: ServiceStatus }) {
  const rate = (b: number | null) => (b == null ? "–" : `${fmtBytes(b)}/s`);
  return (
    <div className="grid g2">
      <div className="card">
        <div className="card-head">
          <h3>CPU · {sys.cpu_count} threads</h3>
          {sys.load.some((l) => l > 0) && <span className="chip">load {sys.load.map((l) => l.toFixed(2)).join(" ")}</span>}
        </div>
        <Meter label="CPU" value={`${sys.cpu_pct.toFixed(1)}%`} p={sys.cpu_pct} />
        <div className="cores">
          {sys.cpu_per_core.map((c, i) => (
            <i key={i} title={`${c.toFixed(0)}%`}><b style={{ height: `${c}%` }} /></i>
          ))}
        </div>
        <div className="sparkrow">
          <SparkCell label="CPU history" value={`${sys.cpu_pct.toFixed(0)}%`} values={hist.map((p) => p.cpu)} max={100} />
          <SparkCell label="RAM history" value={`${sys.mem.pct.toFixed(0)}%`} values={hist.map((p) => p.mem)} max={100} />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Memory &amp; storage</h3>
          <span className="chip">up {fmtDur(sys.uptime_s)}</span>
        </div>
        <Meter label="RAM" value={`${fmtBytes(sys.mem.used)} / ${fmtBytes(sys.mem.total)}`} p={sys.mem.pct} />
        {sys.swap.total > 0 && <Meter label="Swap" value={`${fmtBytes(sys.swap.used)} / ${fmtBytes(sys.swap.total)}`} p={sys.swap.pct} />}
        {sys.disks.map((d) => (
          <Meter key={d.path} label={`Disk ${d.path}`} value={`${fmtBytes(d.used)} / ${fmtBytes(d.total)}`} p={d.pct} cls={level(d.pct, 80, 92)} />
        ))}
        <div className="stats" style={{ marginTop: 12 }}>
          <Stat k="Net in" v={rate(sys.net.rx_bps)} small />
          <Stat k="Net out" v={rate(sys.net.tx_bps)} small />
          <Stat k="Ollama RSS" v={sys.ollama_process ? fmtBytes(sys.ollama_process.rss_total) : "–"} small />
          <Stat k="Runners" v={sys.ollama_process ? sys.ollama_process.runners : "–"} small />
        </div>
        {svc.since && (
          <div className="hint" style={{ marginTop: 10 }}>
            Ollama {svc.active} since {svc.since}
            {svc.restarts ? ` · ${svc.restarts} auto-restarts` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
