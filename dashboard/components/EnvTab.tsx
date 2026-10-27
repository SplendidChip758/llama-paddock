"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, instPath } from "@/lib/format";
import type { EnvState, InstanceSnapshot } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";

const ENV_KNOWN: Record<string, { d: string; opts?: string[] }> = {
  OLLAMA_HOST: { d: "Bind address, e.g. 0.0.0.0:11434" },
  OLLAMA_MODELS: { d: "Model storage directory (must be writable by the Ollama process)" },
  OLLAMA_KEEP_ALIVE: { d: "How long idle models stay loaded: 5m, 1h, -1 = forever, 0 = unload immediately" },
  OLLAMA_MAX_LOADED_MODELS: { d: "Max models resident at once (per GPU fit)" },
  OLLAMA_NUM_PARALLEL: { d: "Parallel requests per model — each slot multiplies KV cache memory" },
  OLLAMA_MAX_QUEUE: { d: "Max queued requests before returning 503" },
  OLLAMA_CONTEXT_LENGTH: { d: "Default context window when a model/request doesn't set num_ctx" },
  OLLAMA_FLASH_ATTENTION: { d: "Enable flash attention (required for quantized KV cache)", opts: ["", "1", "0"] },
  OLLAMA_KV_CACHE_TYPE: { d: "KV cache precision: q8_0 ≈ half of f16, q4_0 ≈ quarter", opts: ["", "f16", "q8_0", "q4_0"] },
  OLLAMA_GPU_OVERHEAD: { d: "Bytes of VRAM to reserve per GPU (e.g. 536870912 = 512 MiB)" },
  OLLAMA_SCHED_SPREAD: { d: "Spread every model across all GPUs", opts: ["", "1", "0"] },
  OLLAMA_LOAD_TIMEOUT: { d: "Give up on a stalled model load after this long (e.g. 5m)" },
  OLLAMA_ORIGINS: { d: "Extra allowed CORS origins, comma separated" },
  OLLAMA_DEBUG: { d: "Verbose server logging", opts: ["", "1", "0"] },
  OLLAMA_NOPRUNE: { d: "Don't prune unused blobs on startup", opts: ["", "1", "0"] },
  CUDA_VISIBLE_DEVICES: { d: "Restrict which GPUs Ollama can use (index or UUID list)" },
};

export function EnvTab({ st }: { st: InstanceSnapshot }) {
  const { toast } = usePaddock();
  const [env, setEnv] = useState<EnvState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<EnvState>(instPath(st.id, "/env"));
      setEnv(d);
      setValues({ ...d.managed });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [st.id]);

  useEffect(() => {
    if (st.has_agent) load();
  }, [load, st.has_agent]);

  const original = useMemo(() => env?.managed ?? {}, [env]);
  const keys = [...new Set([...Object.keys(ENV_KNOWN), ...Object.keys(values)])];
  const cleaned = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ""));
  const changes = [...new Set([...Object.keys(cleaned(values)), ...Object.keys(original)])].filter(
    (k) => (original[k] ?? "") !== (values[k] ?? ""),
  );

  if (!st.has_agent) return <div className="notice">Environment management needs the llama-paddock agent on this host.</div>;
  if (error) return <div className="notice bad">{error}</div>;
  if (!env) return <div className="empty">Loading environment…</div>;

  const windows = env.platform === "windows";
  const external = env.external ?? {};

  const save = async (restart: boolean) => {
    const out = cleaned(values);
    if (!changes.length) return toast("Nothing changed");
    const summary = changes.map((k) => `  ${k}: ${original[k] ?? "(unset)"} → ${out[k] ?? "(unset)"}`).join("\n");
    if (!confirm(`Apply to ${st.name}${restart ? " and restart Ollama" : ""}?\n\n${summary}`)) return;
    setSaving(true);
    try {
      const r = await api<{ restart?: { ok: boolean; stderr?: string } }>(instPath(st.id, "/env"), { method: "PUT", body: { vars: out, restart } });
      if (restart && r.restart && !r.restart.ok) toast(`Saved, but restart failed: ${r.restart.stderr}`, "bad");
      else toast(restart ? "Saved — Ollama restarted" : "Saved — takes effect on next restart", "ok");
      await load();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setSaving(false);
    }
  };

  const addVar = (e: React.FormEvent) => {
    e.preventDefault();
    const k = newKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return toast("Invalid variable name", "bad");
    setValues({ ...values, [k]: newVal.trim() });
    setNewKey("");
    setNewVal("");
  };

  const clearVar = (k: string) => {
    const next = { ...values, [k]: "" };
    if (!(k in ENV_KNOWN) && !(k in original)) delete next[k];
    setValues(next);
  };

  return (
    <>
      <div className="notice">
        {windows ? (
          <>
            Editing your <span className="mono">user environment variables</span> ({env.override_path}). Only Ollama-related variables are
            shown or changed. Saving restarts the Ollama app with the new values — loaded models will drop.
          </>
        ) : (
          <>
            Editing <span className="mono">{env.override_path}</span>. Saving rewrites its <span className="mono">Environment=</span> lines
            (other directives are kept, a timestamped backup is made), runs <span className="mono">daemon-reload</span>, and restarts
            Ollama — loaded models will drop.
          </>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Ollama environment</h3>
          <span className="sub">{changes.length ? "unsaved changes" : ""}</span>
        </div>
        {keys.map((k) => {
          const meta = ENV_KNOWN[k];
          const v = values[k] ?? "";
          const ext = external[k];
          const changed = (original[k] ?? "") !== v;
          const ph = ext != null ? `inherited: ${ext}` : "not set (Ollama default)";
          const set = (val: string) => setValues({ ...values, [k]: val.trim() });
          return (
            <div key={k} className={`envrow ${changed ? "changed" : ""} ${v === "" ? "unset" : ""}`}>
              <div>
                <div className="key">{k}</div>
                {meta && <div className="desc">{meta.d}</div>}
              </div>
              {meta?.opts ? (
                <select value={v} onChange={(e) => set(e.target.value)}>
                  {meta.opts.map((o) => <option key={o} value={o}>{o === "" ? ph : o}</option>)}
                  {v && !meta.opts.includes(v) && <option value={v}>{v}</option>}
                </select>
              ) : (
                <input type="text" value={v} placeholder={ph} onChange={(e) => set(e.target.value)} />
              )}
              <button className="ghost sm" title="unset" disabled={v === ""} onClick={() => clearVar(k)}>✕</button>
            </div>
          );
        })}
        <form className="row" style={{ marginTop: 14 }} onSubmit={addVar}>
          <input type="text" placeholder="NEW_VARIABLE" style={{ maxWidth: 280 }} value={newKey} onChange={(e) => setNewKey(e.target.value)} autoComplete="off" />
          <input type="text" placeholder="value" className="grow" value={newVal} onChange={(e) => setNewVal(e.target.value)} autoComplete="off" />
          <button className="btn" type="submit">Add</button>
        </form>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 18 }}>
          <button className="ghost" onClick={() => setValues({ ...original })}>Reset</button>
          <button className="btn" disabled={saving} onClick={() => save(false)}>Save without restart</button>
          <button className="btn primary" disabled={saving} onClick={() => save(true)}>Save &amp; restart Ollama</button>
        </div>
      </div>

      {Object.keys(external).length > 0 && (
        <div className="section">
          <h2>Set elsewhere (read-only)</h2>
          <div className="card">
            <table>
              <tbody>
                {Object.entries(external).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono" style={{ width: 280 }}>{k}</td>
                    <td className="mono faint" style={{ wordBreak: "break-all" }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint" style={{ marginTop: 8 }}>
              {windows
                ? "These are system-wide environment variables. A user value set above overrides them."
                : "These come from the main unit file or another drop-in. A value set above overrides them."}
            </div>
          </div>
        </div>
      )}
      <details className="section">
        <summary className="sub" style={{ cursor: "pointer" }}>{windows ? "Current raw values" : "Current override file"}</summary>
        <pre className="logs" style={{ marginTop: 8 }}>{env.raw || "(nothing set yet)"}</pre>
      </details>
    </>
  );
}
