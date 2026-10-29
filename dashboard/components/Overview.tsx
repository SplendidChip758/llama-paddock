"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { fmtDur, fmtMiB, pct } from "@/lib/format";
import type { InstanceSnapshot } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Meter, Stat, statusOf } from "./ui";
import { HostEditor } from "./HostEditor";

export function Overview() {
  const { instances, loaded, pollInterval } = usePaddock();
  const [adding, setAdding] = useState(false);
  if (!loaded) return <div className="empty">Connecting…</div>;

  const editor = adding && <HostEditor onClose={() => setAdding(false)} />;
  if (!instances.length) {
    return (
      <div className="welcome card">
        <h1>Add your first Ollama host</h1>
        <p className="sub">
          Point the dashboard at an Ollama server. Install the agent on that host as well for GPU and host stats, environment
          editing, restart and logs.
        </p>
        <button className="btn primary" onClick={() => setAdding(true)}>Add host</button>
        {editor}
      </div>
    );
  }

  const gpus = instances.flatMap((s) => s.stats?.nvidia?.gpus ?? []);
  const vUsed = gpus.reduce((a, g) => a + (g.mem_used_mib ?? 0), 0);
  const vTot = gpus.reduce((a, g) => a + (g.mem_total_mib ?? 0), 0);
  const watts = gpus.reduce((a, g) => a + (g.power_w ?? 0), 0);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Fleet overview</h1>
          <div className="sub">
            {instances.length} instance{instances.length === 1 ? "" : "s"} · refreshing every {pollInterval}s
          </div>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>Add host</button>
      </div>
      {editor}
      <div className="stats" style={{ marginBottom: 18 }}>
        <Stat k="Online" v={instances.filter((s) => s.ollama_ok).length} unit={`/ ${instances.length}`} />
        <Stat k="GPUs" v={gpus.length} />
        <Stat k="VRAM used" v={fmtMiB(vUsed)} unit={`/ ${fmtMiB(vTot)}`} />
        <Stat k="GPU power" v={watts.toFixed(0)} unit="W" />
        <Stat k="Models loaded" v={instances.reduce((a, s) => a + s.ps.length, 0)} />
      </div>
      <div className="grid g3">
        {instances.map((st) => <InstCard key={st.id} st={st} />)}
      </div>
    </>
  );
}

function InstCard({ st }: { st: InstanceSnapshot }) {
  const router = useRouter();
  const [c, label] = statusOf(st);
  const sys = st.stats?.system;
  const gpus = st.stats?.nvidia?.gpus ?? [];
  const err = st.ollama_error || st.agent_error;
  const platform = st.stats?.platform;
  return (
    <div className="card inst-card" onClick={() => router.push(`/i/${encodeURIComponent(st.id)}/monitor`)}>
      <div className="card-head">
        <div className="title">
          <span className={`dot ${c}`} />
          <h3>{st.name}</h3>
        </div>
        <span className={`chip ${c === "ok" ? "ok" : c === "bad" ? "bad" : ""}`}>{label}</span>
      </div>
      <dl className="kv">
        <dt>Ollama</dt>
        <dd>{st.version ?? "–"}</dd>
        {st.has_agent && (<><dt>Agent</dt><dd>{st.agent_version ?? "unknown"}</dd></>)}
        <dt>Endpoint</dt>
        <dd>{st.ollama_url.replace(/^https?:\/\//, "")}</dd>
        {platform && (<><dt>Platform</dt><dd>{platform}</dd></>)}
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
        {st.ps.length ? st.ps.map((m) => <span key={m.name} className="chip acc">{m.name}</span>) : <span className="faint" style={{ fontSize: 12.5 }}>No models loaded</span>}
      </div>
      {err && <div className="hint" style={{ color: "var(--bad)", marginTop: 10 }}>{err}</div>}
    </div>
  );
}
