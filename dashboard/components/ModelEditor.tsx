"use client";

import { useEffect, useState } from "react";
import { api, fmtNum, instPath } from "@/lib/format";
import type { ParamValue, ShowResult } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

const PARAM_KNOWN: Record<string, string> = {
  num_ctx: "Context window in tokens",
  num_predict: "Max tokens to generate (-1 = unlimited)",
  temperature: "Sampling temperature",
  top_k: "Top-K sampling",
  top_p: "Nucleus sampling",
  min_p: "Min-P sampling",
  repeat_penalty: "Penalty for repeated tokens",
  repeat_last_n: "Look-back window for repeat penalty",
  seed: "Fixed RNG seed",
  num_gpu: "Layers to offload to GPU (999 = all)",
  num_thread: "CPU threads",
  num_batch: "Prompt processing batch size",
  stop: "Stop sequences (one per line)",
};
const CTX_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072];

export function suggestName(name: string, ctx: ParamValue | undefined): string {
  const [repo, tag = "latest"] = name.split(":");
  if (!ctx || Array.isArray(ctx)) return name;
  const n = Number(ctx);
  const k = n >= 1024 ? `${Math.round(n / 1024)}k` : `${n}`;
  const cleanTag = tag.replace(/-?ctx\d+k?$/i, "");
  return `${repo}:${cleanTag === "latest" || cleanTag === "" ? "" : cleanTag + "-"}ctx${k}`;
}

export function ModelEditor({ instanceId, model, onClose }: { instanceId: string; model: string; onClose: () => void }) {
  const { toast, refreshJobs, setJobsOpen } = usePaddock();
  const [info, setInfo] = useState<ShowResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [system, setSystem] = useState("");
  const [target, setTarget] = useState(model);
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    api<ShowResult>(instPath(instanceId, "/models/show"), { method: "POST", body: { model } })
      .then((d) => {
        setInfo(d);
        setParams(d.parameters);
        setSystem(d.system ?? "");
        setTarget(suggestName(model, d.parameters.num_ctx));
      })
      .catch((e) => setError(e.message));
  }, [instanceId, model]);

  const setParam = (k: string, v: ParamValue) => {
    const next = { ...params, [k]: v };
    setParams(next);
    if (k === "num_ctx" && !nameTouched) setTarget(suggestName(model, v));
  };
  const removeParam = (k: string) => {
    const next = { ...params };
    delete next[k];
    setParams(next);
    if (k === "num_ctx" && !nameTouched) setTarget(model);
  };
  const addParam = (k: string) => {
    if (k === "__custom") k = (prompt("Parameter name:") ?? "").trim();
    if (!k || k in params) return;
    setParams({ ...params, [k]: k === "stop" ? [] : "" });
  };

  const save = async () => {
    const name = target.trim();
    if (!name) return toast("Enter a model name", "bad");
    if (name === model && !confirm(`Overwrite ${model} in place?`)) return;
    const body: Record<string, unknown> = { model: name, from: model, parameters: params };
    if (system !== (info?.system ?? "")) body.system = system;
    try {
      await api(instPath(instanceId, "/models/create"), { method: "POST", body });
      toast(`Creating ${name}…`);
      onClose();
      await refreshJobs();
      setJobsOpen(true);
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  const d = info?.details ?? {};
  const nctx = info?.native_context_length;
  const chips = [...new Set([d.family, info?.architecture, d.parameter_size, d.quantization_level].filter(Boolean) as string[])];
  const same = target.trim() === model;

  return (
    <Drawer open onClose={onClose} className="editdrawer">
      <div className="drawer-head">
        <h3>Edit {model}</h3>
        <button className="ghost" onClick={onClose}>✕</button>
      </div>
      {error && <div className="notice bad">{error}</div>}
      {!info && !error && <div className="empty">Loading…</div>}
      {info && (
        <>
          <div className="chips" style={{ marginBottom: 14 }}>
            {chips.map((c) => <span key={c} className="chip">{c}</span>)}
            {nctx && <span className="chip acc">native ctx {fmtNum(nctx)}</span>}
            {(info.capabilities ?? []).map((c) => <span key={c} className="chip">{c}</span>)}
          </div>
          <div className="notice">
            Ollama models are immutable, so edits create a model layered on top of <b>{model}</b> (no weights are copied). Saving under
            the same name replaces it in place.
          </div>

          <label className="field">
            <span>Save as</span>
            <input type="text" value={target} onChange={(e) => { setTarget(e.target.value); setNameTouched(true); }} />
            <div className="hint">
              {same ? (
                <span style={{ color: "var(--warn)" }}>Overwrites {model} in place. If it came from the registry, a future pull will reset it.</span>
              ) : (
                <>New model; <b>{model}</b> stays untouched.</>
              )}
            </div>
          </label>

          <h2 style={{ margin: "18px 0 10px" }}>Context window</h2>
          <div className="chips" style={{ marginBottom: 6 }}>
            {CTX_PRESETS.filter((c) => !nctx || c <= nctx).map((c) => (
              <button key={c} className="btn sm" onClick={() => setParam("num_ctx", c)}
                style={Number(params.num_ctx) === c ? { borderColor: "var(--accent)" } : undefined}>
                {c / 1024}K
              </button>
            ))}
            {nctx && <button className="btn sm" onClick={() => setParam("num_ctx", nctx)}>max</button>}
          </div>
          <div className="hint">
            Bigger contexts grow the KV cache: check VRAM on the Monitor tab after loading. With OLLAMA_KV_CACHE_TYPE=q8_0 the cache is roughly halved.
          </div>

          <h2 style={{ margin: "18px 0 10px" }}>Parameters</h2>
          {Object.keys(params).length === 0 && <div className="hint">No parameters set — the model uses Ollama defaults.</div>}
          {Object.entries(params).map(([k, v]) => (
            <div className="paramrow" key={k}>
              <div className="key">{k}<small>{PARAM_KNOWN[k] ?? ""}</small></div>
              {k === "stop" ? (
                <textarea rows={3} value={(Array.isArray(v) ? v : [String(v)]).join("\n")}
                  onChange={(e) => setParam(k, e.target.value.split("\n").filter((s) => s.length))} />
              ) : (
                <input type="text" value={String(v)} onChange={(e) => setParam(k, e.target.value)} />
              )}
              <button className="ghost sm" title="remove" onClick={() => removeParam(k)}>✕</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 6 }}>
            <select className="grow" value="" onChange={(e) => addParam(e.target.value)}>
              <option value="">Add parameter…</option>
              {Object.keys(PARAM_KNOWN).filter((k) => !(k in params)).map((k) => (
                <option key={k} value={k}>{k} — {PARAM_KNOWN[k]}</option>
              ))}
              <option value="__custom">custom…</option>
            </select>
          </div>

          <h2 style={{ margin: "22px 0 10px" }}>System prompt</h2>
          <textarea rows={6} placeholder="(inherited / none)" value={system} onChange={(e) => setSystem(e.target.value)} />

          <details style={{ marginTop: 16 }}>
            <summary className="sub" style={{ cursor: "pointer" }}>Current parameters (raw)</summary>
            <pre className="logs" style={{ marginTop: 8 }}>{info.parameters_raw || "(none)"}</pre>
          </details>

          <div className="row" style={{ marginTop: 20, justifyContent: "flex-end" }}>
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save}>Create model</button>
          </div>
        </>
      )}
    </Drawer>
  );
}
