"use client";

import { useState } from "react";
import { api, fmtDur, instPath } from "@/lib/format";
import type { GpuCheck, GpuFix, InstanceSnapshot } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";

const STATE: Record<GpuCheck["state"], [string, string]> = {
  ok: ["ok", "uses the GPU"],
  lost: ["bad", "GPU lost"],
  cpu_intended: ["", "CPU on purpose"],
  unknown: ["", "not known yet"],
};

/** Whether Ollama uses the GPU nvidia-smi sees: one line while it does, the causes and fixes when it doesn't. */
export function GpuCheckCard({ st }: { st: InstanceSnapshot }) {
  const { toast, readOnly } = usePaddock();
  const [busy, setBusy] = useState<string | null>(null);
  const c = st.gpu_check;
  if (!c) return null;
  const [cls, label] = STATE[c.state];
  const lost = c.state === "lost";

  const recheck = async () => {
    setBusy("check");
    try {
      await api(instPath(st.id, "/gpu-check"), { method: "POST" });
      toast("Read Ollama's log again", "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const run = async (f: GpuFix) => {
    if (!confirm(`${f.label} on ${st.name}?\n\n${f.detail}`)) return;
    setBusy(f.action);
    try {
      const r = await api<{ ok: boolean; stderr?: string }>(instPath(st.id, "/gpu-check/fix"), { method: "POST", body: { action: f.action } });
      toast(r.ok ? `${f.label}: done. The check runs again once Ollama is back.` : `${f.label} failed: ${r.stderr ?? "no details"}`, r.ok ? "ok" : "bad");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const checked = c.checked_at ? `log read ${fmtDur(Math.max(0, Date.now() / 1000 - c.checked_at))} ago` : "log not read yet";
  const recheckButton = (
    <button className="btn sm" onClick={recheck} disabled={!!busy}>{busy === "check" ? "Checking…" : "Check again"}</button>
  );
  const details = (
    <details className="gpucheck-details">
      <summary>Evidence{c.log_lines.length ? ` and ${c.log_lines.length} log line${c.log_lines.length === 1 ? "" : "s"}` : ""}</summary>
      <ul>{c.evidence.map((x) => <li key={x}>{x}</li>)}</ul>
      {c.notes.map((n) => <div key={n} className="hint">{n}</div>)}
      {c.log_lines.length > 0 && <pre className="logs">{c.log_lines.join("\n")}</pre>}
    </details>
  );

  if (!lost) {
    return (
      <div className="notice gpucheck">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>
            <span className={`chip ${cls}`}>GPU check · {label}</span> {c.summary} <span className="faint">({checked})</span>
          </span>
          {recheckButton}
        </div>
        {details}
      </div>
    );
  }

  return (
    <div className="notice bad gpucheck" role="alert">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className={`chip ${cls}`}>GPU check · {label}</span>
        <span className="row">
          <span className="faint">{checked}</span>
          {recheckButton}
        </span>
      </div>
      <p>{c.summary}</p>
      {c.causes.length > 0 && (
        <>
          <h4>Likely cause{c.causes.length === 1 ? "" : "s"}</h4>
          <ul>{c.causes.map((x) => <li key={x}>{x}</li>)}</ul>
        </>
      )}
      <h4>Fix</h4>
      <ul className="gpucheck-fixes">
        {c.fixes.map((f) => (
          <li key={f.label}>
            {f.action && !readOnly ? (
              <button className="btn sm" onClick={() => run(f)} disabled={!!busy}>{busy === f.action ? "Working…" : f.label}</button>
            ) : (
              <b>{f.label}</b>
            )}{" "}
            <span className="faint">{f.detail}</span>
            {f.command && <div><code>{f.command}</code></div>}
          </li>
        ))}
      </ul>
      {details}
    </div>
  );
}
