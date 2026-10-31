"use client";

import Link from "next/link";
import { useState } from "react";
import { api, instPath } from "@/lib/format";
import { usePaddock } from "./PaddockProvider";
import { statusOf } from "./ui";
import { MonitorTab } from "./MonitorTab";
import { ModelsTab } from "./ModelsTab";
import { EnvTab } from "./EnvTab";
import { LogsTab } from "./LogsTab";
import { TABS, type Tab } from "@/lib/tabs";
import { HostEditor } from "./HostEditor";
import { AgentKeyNotice, AgentPlainChip, HttpsOffer, agentEncrypted } from "./AgentTls";

export function InstanceView({ id, tab }: { id: string; tab: Tab }) {
  const { instances, loaded, toast } = usePaddock();
  const [restarting, setRestarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const st = instances.find((i) => i.id === id);

  if (!loaded) return <div className="empty">Connecting…</div>;
  if (!st) return <div className="notice bad">Unknown instance “{id}”.</div>;

  const [c, label] = statusOf(st);
  const svc = st.stats?.service;
  const platform = st.stats?.platform;

  const restart = async () => {
    if (!confirm(`Restart Ollama on ${st.name}? All loaded models will be unloaded.`)) return;
    setRestarting(true);
    try {
      const r = await api<{ ok: boolean; stderr?: string }>(instPath(id, "/restart"), { method: "POST" });
      toast(r.ok ? "Ollama restarted" : `Restart failed: ${r.stderr}`, r.ok ? "ok" : "bad");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setRestarting(false);
    }
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <div className="row">
            <span className={`dot ${c}`} />
            <h1>{st.name}</h1>
          </div>
          <div className="meta">
            <span>{label}</span>
            <span className="mono">{st.ollama_url}</span>
            <span>Ollama {st.version ?? "–"}</span>
            {st.has_agent && (
              <span title={agentEncrypted(st) ? `HTTPS, key ${st.agent_fingerprint ?? "pinned on first connection"}` : undefined}>
                agent {st.agent_version ?? "unknown"}{agentEncrypted(st) ? " · HTTPS" : ""}
              </span>
            )}
            <AgentPlainChip st={st} />
            {st.stats && <span>host {st.stats.system.hostname}{platform ? ` (${platform})` : ""}</span>}
            {svc && <span>service: {svc.active}{svc.sub ? `/${svc.sub}` : ""}</span>}
          </div>
        </div>
        <div className="row">
          {st.source === "ui" ? (
            <button className="btn" onClick={() => setEditing(true)}>Edit host</button>
          ) : (
            <span className="chip" title="Defined in config.yaml. Edit it there and restart the dashboard.">config.yaml</span>
          )}
          {st.has_agent && (
            <button className="btn" onClick={restart} disabled={restarting}>
              {restarting ? "Restarting…" : "Restart Ollama"}
            </button>
          )}
        </div>
      </div>
      {editing && <HostEditor host={st} onClose={() => setEditing(false)} />}
      {st.ollama_error && <div className="notice bad">Ollama: {st.ollama_error}</div>}
      <AgentKeyNotice st={st} />
      {st.agent_error && !st.agent_key_changed && <div className="notice warn">Agent: {st.agent_error}</div>}
      <HttpsOffer st={st} />
      <nav className="tabs">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/i/${encodeURIComponent(id)}/${k}`} className={tab === k ? "active" : ""}>
            {l}
          </Link>
        ))}
      </nav>
      {tab === "monitor" && <MonitorTab st={st} />}
      {tab === "models" && <ModelsTab st={st} />}
      {tab === "env" && <EnvTab st={st} key={id} />}
      {tab === "logs" && <LogsTab st={st} key={id} />}
    </>
  );
}
