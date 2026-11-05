"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, fmtDur, fmtMiB, pct } from "@/lib/format";
import type { InstanceSnapshot } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { isOffloaded } from "@/lib/split";
import { Meter, SplitChip, Stat, statusOf } from "./ui";
import { HostEditor } from "./HostEditor";
import { AgentPlainChip, FleetHttpsOffer } from "./AgentTls";
import { loudAlerts } from "./AlertBits";

interface UptimeBrief {
  coverage: number;
  ollama: { up_pct: number | null; outages: number };
  agent: { up_pct: number | null; outages: number } | null;
}

const UPTIME_REFRESH_MS = 60_000;

export function Overview() {
  const { instances, loaded, pollInterval, readOnly } = usePaddock();
  const [adding, setAdding] = useState(false);
  const [uptime, setUptime] = useState<Record<string, UptimeBrief>>({});
  useEffect(() => {
    const load = () => api<{ hosts: Record<string, UptimeBrief> }>("/api/uptime?range=30d").then((d) => setUptime(d.hosts)).catch(() => {});
    load();
    const t = setInterval(load, UPTIME_REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  if (!loaded) return <div className="empty">Connecting…</div>;

  const editor = adding && <HostEditor onClose={() => setAdding(false)} />;
  if (!instances.length) {
    return (
      <div className="welcome card">
        <h1>{readOnly ? "No hosts yet" : "Add your first Ollama host"}</h1>
        <p className="sub">
          {readOnly
            ? "An admin can add Ollama hosts to the dashboard. They show up here once they have."
            : "Point the dashboard at an Ollama server. Install the agent on that host as well for GPU and host stats, environment editing, restart and logs."}
        </p>
        {!readOnly && <button className="btn primary" onClick={() => setAdding(true)}>Add host</button>}
        {editor}
      </div>
    );
  }

  const gpus = instances.flatMap((s) => s.stats?.nvidia?.gpus ?? []);
  const vUsed = gpus.reduce((a, g) => a + (g.mem_used_mib ?? 0), 0);
  const vTot = gpus.reduce((a, g) => a + (g.mem_total_mib ?? 0), 0);
  const watts = gpus.reduce((a, g) => a + (g.power_w ?? 0), 0);
  const offloaded = instances.reduce((a, s) => a + s.ps.filter((m) => isOffloaded(m.split)).length, 0);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Fleet overview</h1>
          <div className="sub">
            {instances.length} instance{instances.length === 1 ? "" : "s"} · refreshing every {pollInterval}s
          </div>
        </div>
        {!readOnly && <button className="btn primary" onClick={() => setAdding(true)}>Add host</button>}
      </div>
      {editor}
      <FleetHttpsOffer instances={instances} />
      <div className="stats" style={{ marginBottom: 18 }}>
        <Stat k="Online" v={instances.filter((s) => s.ollama_ok).length} unit={`/ ${instances.length}`} />
        <Stat k="GPUs" v={gpus.length} />
        <Stat k="VRAM used" v={fmtMiB(vUsed)} unit={`/ ${fmtMiB(vTot)}`} />
        <Stat k="GPU power" v={watts.toFixed(0)} unit="W" />
        <Stat k="Models loaded" v={instances.reduce((a, s) => a + s.ps.length, 0)} unit={offloaded ? `${offloaded} not fully on GPU` : undefined} />
      </div>
      <div className="grid hostgrid">
        {instances.map((st) => <InstCard key={st.id} st={st} uptime={uptime[st.id]} />)}
      </div>
    </>
  );
}

const pctText = (p: number | null | undefined) => (p == null ? "–" : `${p >= 99.95 && p < 100 ? "99.9" : p.toFixed(p === 100 ? 0 : 1)}%`);

function InstCard({ st, uptime }: { st: InstanceSnapshot; uptime?: UptimeBrief }) {
  const router = useRouter();
  const { alerts } = usePaddock();
  const firing = loudAlerts(alerts).filter((a) => a.instance === st.id).length;
  const [c, label] = statusOf(st);
  const sys = st.stats?.system;
  const gpus = st.stats?.nvidia?.gpus ?? [];
  const err = st.ollama_error || (st.agent_key_changed ? "the agent's key has changed: open the host to review it" : st.agent_error);
  const platform = st.stats?.platform;
  const offloaded = st.ps.filter((m) => isOffloaded(m.split));
  return (
    <div className="card inst-card" onClick={() => router.push(`/i/${encodeURIComponent(st.id)}/monitor`)}>
      <div className="card-head">
        <div className="title">
          <span className={`dot ${c}`} />
          <h3>{st.name}</h3>
        </div>
        <div className="chips">
          {firing > 0 && (
            <button className="chip bad" title="Open this host's alerts"
              onClick={(e) => { e.stopPropagation(); router.push(`/alerts?host=${encodeURIComponent(st.id)}`); }}>
              {firing} alert{firing === 1 ? "" : "s"}
            </button>
          )}
          <AgentPlainChip st={st} />
          {st.gpu_check?.state === "lost" && <span className="chip bad" title={st.gpu_check.summary}>GPU lost</span>}
          {st.reload_churn.length > 0 && <span className="chip warn" title={st.reload_churn.map((x) => x.summary).join(" ")}>reloading</span>}
          <span className={`chip ${c === "ok" ? "ok" : c === "bad" ? "bad" : ""}`}>{label}</span>
        </div>
      </div>
      <dl className="kv">
        <dt>Ollama</dt>
        <dd>{st.version ?? "–"}</dd>
        {st.has_agent && (<><dt>Agent</dt><dd>{st.agent_version ?? "unknown"}</dd></>)}
        <dt>Endpoint</dt>
        <dd>{st.ollama_url.replace(/^https?:\/\//, "")}</dd>
        {platform && (<><dt>Platform</dt><dd>{platform}</dd></>)}
        {uptime && uptime.ollama.up_pct != null && (
          <>
            <dt title="Share of the time the dashboard was watching over the last 30 days">Availability (30d)</dt>
            <dd>
              {pctText(uptime.ollama.up_pct)}{uptime.agent ? ` · agent ${pctText(uptime.agent.up_pct)}` : ""}
            </dd>
          </>
        )}
        {sys && (
          <>
            <dt>CPU / RAM</dt>
            <dd>{sys.cpu_pct.toFixed(0)}% · {sys.mem.pct.toFixed(0)}%</dd>
            <dt>Uptime</dt>
            <dd>{fmtDur(sys.uptime_s)}</dd>
          </>
        )}
      </dl>
      {gpus.map((g) => (
        <div key={g.uuid} style={{ marginTop: 8 }}>
          <div className="faint" style={{ fontSize: 12 }}>
            GPU{g.index} · {g.name} · {g.temp_c ?? "–"}°C · {g.power_w != null ? `${Math.round(g.power_w)}W` : "–"}
          </div>
          <Meter label="Utilization" value={`${g.util_pct ?? 0}%`} p={g.util_pct ?? 0} />
          <Meter label="VRAM" value={`${fmtMiB(g.mem_used_mib)} / ${fmtMiB(g.mem_total_mib)}`} p={pct(g.mem_used_mib, g.mem_total_mib)} />
        </div>
      ))}
      {!st.has_agent && <div className="hint" style={{ marginTop: 10 }}>No agent — GPU/host stats unavailable</div>}
      <div className="chips" style={{ marginTop: 12 }}>
        {st.ps.length ? st.ps.map((m) => <SplitChip key={m.name} m={m} />) : <span className="faint" style={{ fontSize: 12.5 }}>No models loaded</span>}
      </div>
      {offloaded.length > 0 && (
        <div className="split-note">
          <b>Not fully on the GPU:</b> {offloaded.map((m) => m.name).join(", ")}. If that isn't intended, try a smaller num_ctx
          or quantization, or unload other models. The Diagnostics tab has details.
        </div>
      )}
      {err && <div className="hint" style={{ color: "var(--bad)", marginTop: 10 }}>{err}</div>}
    </div>
  );
}
