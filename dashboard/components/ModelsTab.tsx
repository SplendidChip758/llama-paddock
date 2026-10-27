"use client";

import { useCallback, useEffect, useState } from "react";
import { ago, api, fmtBytes, instPath } from "@/lib/format";
import type { InstanceSnapshot, TagModel } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { JobLine } from "./JobsDrawer";
import { ModelEditor } from "./ModelEditor";

export function ModelsTab({ st }: { st: InstanceSnapshot }) {
  const { toast, jobs, setJobsOpen, refreshJobs, jobsDoneTick } = usePaddock();
  const [models, setModels] = useState<TagModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pullName, setPullName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ models: TagModel[] }>(instPath(st.id, "/models"));
      setModels([...d.models].sort((a, b) => a.name.localeCompare(b.name)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [st.id]);

  useEffect(() => {
    load();
  }, [load, jobsDoneTick]);

  const loaded = new Set(st.ps.map((m) => m.name));
  const running = jobs.filter((j) => j.instance === st.id && j.state === "running");

  const pull = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = pullName.trim();
    if (!name) return;
    try {
      await api(instPath(st.id, "/models/pull"), { method: "POST", body: { model: name } });
      toast(`Pulling ${name}…`);
      setPullName("");
      await refreshJobs();
      setJobsOpen(true);
    } catch (err) {
      toast((err as Error).message, "bad");
    }
  };

  const act = async (action: string, name: string) => {
    const base = instPath(st.id, "/models");
    try {
      if (action === "delete") {
        if (!confirm(`Delete ${name} from ${st.name}? This removes it from disk.`)) return;
        await api(`${base}/delete`, { method: "POST", body: { model: name } });
        toast(`Deleted ${name}`, "ok");
      } else if (action === "copy") {
        const dest = prompt(`Copy ${name} to new name:`, `${name.split(":")[0]}-copy`);
        if (!dest) return;
        await api(`${base}/copy`, { method: "POST", body: { source: name, destination: dest } });
        toast(`Copied to ${dest}`, "ok");
      } else {
        setBusy(name);
        await api(`${base}/${action}`, { method: "POST", body: { model: name } });
        toast(`${action === "load" ? "Loaded" : "Unloaded"} ${name}`, "ok");
      }
      load();
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const total = (models ?? []).reduce((a, m) => a + (m.size || 0), 0);

  return (
    <>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">
          <h3>Pull a model</h3>
          <a className="sub" href="https://ollama.com/library" target="_blank" rel="noopener">browse library ↗</a>
        </div>
        <form className="row" onSubmit={pull}>
          <input className="grow" type="text" value={pullName} onChange={(e) => setPullName(e.target.value)}
            placeholder="e.g. qwen3:8b, hermes3:8b, llama3.2:3b-instruct-q8_0" autoComplete="off" />
          <button className="btn primary" type="submit">Pull</button>
        </form>
        {running.length > 0 && <div style={{ marginTop: 10 }}>{running.map((j) => <JobLine key={j.id} j={j} />)}</div>}
      </div>

      {error && <div className="notice bad">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h3>
            {models?.length ?? "…"} models <span className="faint" style={{ fontWeight: 400 }}>· {fmtBytes(total)} on disk</span>
          </h3>
          <button className="ghost sm" onClick={load}>Refresh</button>
        </div>
        {models === null ? (
          <div className="empty">Loading models…</div>
        ) : models.length === 0 ? (
          <div className="empty">No models yet — pull one above.</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Family</th><th>Params</th><th>Quant</th><th className="r">Size</th><th>Modified</th><th /></tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.name}>
                    <td>
                      <span className="name">{m.name}</span> {loaded.has(m.name) && <span className="chip ok">loaded</span>}
                    </td>
                    <td>{m.details?.family ?? "–"}</td>
                    <td>{m.details?.parameter_size ?? "–"}</td>
                    <td>{m.details?.quantization_level ?? "–"}</td>
                    <td className="r num">{fmtBytes(m.size)}</td>
                    <td className="faint">{ago(m.modified_at)}</td>
                    <td>
                      <div className="actions">
                        <button className="btn sm" onClick={() => setEditing(m.name)}>Edit</button>
                        {loaded.has(m.name) ? (
                          <button className="btn sm" disabled={busy === m.name} onClick={() => act("unload", m.name)}>Unload</button>
                        ) : (
                          <button className="btn sm" disabled={busy === m.name} onClick={() => act("load", m.name)}>
                            {busy === m.name ? "Loading…" : "Load"}
                          </button>
                        )}
                        <button className="ghost sm" onClick={() => act("copy", m.name)}>Copy</button>
                        <button className="danger sm" onClick={() => act("delete", m.name)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <ModelEditor instanceId={st.id} model={editing} onClose={() => setEditing(null)} key={editing} />}
    </>
  );
}
