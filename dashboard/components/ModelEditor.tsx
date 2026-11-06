"use client";

import { useEffect, useRef, useState } from "react";
import { api, fmtBytes, fmtNum, instPath } from "@/lib/format";
import type { ParamValue, ShowResult, TagModel } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";
import { FitPanel } from "./FitPanel";

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

/** Starting points for the sampling parameters; applying one only changes the parameters it lists. */
const PRESETS: { label: string; hint: string; params: Record<string, ParamValue> }[] = [
  { label: "Coding", hint: "focused, repeatable answers", params: { temperature: 0.2, top_p: 0.9, repeat_penalty: 1.05 } },
  { label: "Factual", hint: "the least randomness", params: { temperature: 0.1, top_p: 0.5, top_k: 20 } },
  { label: "Chat", hint: "Ollama's usual balance", params: { temperature: 0.8, top_p: 0.9, top_k: 40 } },
  { label: "Creative", hint: "more varied writing", params: { temperature: 1.0, top_p: 0.95, top_k: 60, repeat_penalty: 1.1 } },
  { label: "Long context", hint: "a 32K window: check the fit estimate", params: { num_ctx: 32768 } },
];

export function suggestName(name: string, ctx: ParamValue | undefined): string {
  const [repo, tag = "latest"] = name.split(":");
  if (!ctx || Array.isArray(ctx)) return name;
  const n = Number(ctx);
  const k = n >= 1024 ? `${Math.round(n / 1024)}k` : `${n}`;
  const cleanTag = tag.replace(/-?ctx\d+k?$/i, "");
  return `${repo}:${cleanTag === "latest" || cleanTag === "" ? "" : cleanTag + "-"}ctx${k}`;
}

/** A name for a new model that isn't its base's: the context if one is set, else "-custom". */
function newName(base: string, ctx: ParamValue | undefined): string {
  const plain = base.replace(/^hf\.co\/[^/]+\//i, "").toLowerCase();
  const s = suggestName(plain, ctx);
  if (s !== plain) return s;
  const [repo, tag = "latest"] = plain.split(":");
  return `${repo}:${tag === "latest" ? "" : tag + "-"}custom`;
}

/** A model name from a GGUF file name: a quantization at the end becomes the tag (Llama-3.2-1B.Q4_K_M.gguf → llama-3.2-1b:q4_k_m). */
function uploadName(file: string): string {
  const stem = file.replace(/\.gguf$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const m = /^(.+?)[._-]((?:i?q\d[a-z0-9_]*)|f16|bf16|f32|fp16)$/.exec(stem);
  return m ? `${m[1]}:${m[2]}` : stem;
}

type BaseKind = "host" | "library" | "upload";

interface Upload {
  file: string;
  size: number;
  sent: number;
  phase: "uploading" | "finishing" | "done" | "error";
  error?: string;
  /** set once Ollama has the file */
  digest?: string;
  architecture?: string | null;
  name?: string | null;
  context_length?: number | null;
}

/**
 * Edit an installed model (`model`), or create a new one (`model` null) from a model on the host, a
 * library or Hugging Face model (pulled first), or an uploaded GGUF. Either way Ollama creates a new
 * model; an edit saved under the same name replaces the original.
 */
export function ModelEditor({ instanceId, model, onClose }: { instanceId: string; model: string | null; onClose: () => void }) {
  const { toast, refreshJobs, setJobsOpen } = usePaddock();
  const isNew = model === null;
  const [info, setInfo] = useState<ShowResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, ParamValue>>({});
  const [system, setSystem] = useState("");
  const [template, setTemplate] = useState("");
  const [target, setTarget] = useState(model ?? "");
  const [nameTouched, setNameTouched] = useState(false);

  // ---- the base of a new model
  const [kind, setKind] = useState<BaseKind>("host");
  const [installed, setInstalled] = useState<TagModel[] | null>(null);
  const [hostBase, setHostBase] = useState("");
  const [libInput, setLibInput] = useState("");
  const [libBase, setLibBase] = useState("");
  const [upload, setUpload] = useState<Upload | null>(null);
  const uploadId = useRef<string | null>(null);

  /** The model the editor starts from: what /api/show and the fit estimate are asked about. */
  const base = isNew ? (kind === "host" ? hostBase : kind === "library" ? libBase : "") : model;
  const blob = isNew && kind === "upload" && upload?.phase === "done" ? upload.digest! : null;

  useEffect(() => {
    if (!isNew) return;
    api<{ models: TagModel[] }>(instPath(instanceId, "/models"))
      .then((d) => setInstalled(d.models.filter((m) => !m.cloud).sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => setError(e.message));
  }, [instanceId, isNew]);

  // an installed base (or the edited model): its details, and for an edit its parameters and template
  useEffect(() => {
    setInfo(null);
    if (!base || (isNew && kind !== "host")) return;
    api<ShowResult>(instPath(instanceId, "/models/show"), { method: "POST", body: { model: base } })
      .then((d) => {
        setInfo(d);
        if (isNew) return;
        setParams(d.parameters);
        setSystem(d.system ?? "");
        setTemplate(d.template ?? "");
        setTarget(suggestName(base, d.parameters.num_ctx));
      })
      .catch((e) => setError(e.message));
  }, [instanceId, base, isNew, kind]);

  // abandon a half-finished upload when the editor closes
  useEffect(() => () => {
    if (uploadId.current) void fetch(instPath(instanceId, `/models/upload/${uploadId.current}`), { method: "DELETE" }).catch(() => {});
  }, [instanceId]);

  /** Keep the suggested name in step with the base and context, until the name is typed. `b`: a base just chosen. */
  const rename = (ctx: ParamValue | undefined, b: string = base ?? "") => {
    if (nameTouched) return;
    if (!isNew) setTarget(suggestName(model!, ctx));
    else if (kind === "upload") upload && setTarget(suggestName(uploadName(upload.file), ctx));
    else if (b) setTarget(newName(b, ctx));
  };
  const setParam = (k: string, v: ParamValue) => {
    setParams({ ...params, [k]: v });
    if (k === "num_ctx") rename(v);
  };
  const removeParam = (k: string) => {
    const next = { ...params };
    delete next[k];
    setParams(next);
    if (k === "num_ctx") rename(undefined);
  };
  const addParam = (k: string) => {
    if (k === "__custom") k = (prompt("Parameter name:") ?? "").trim();
    if (!k || k in params) return;
    setParams({ ...params, [k]: k === "stop" ? [] : "" });
  };
  const applyPreset = (p: Record<string, ParamValue>) => {
    const next = { ...params, ...p };
    // the long-context preset can't go past what the model supports
    const max = info?.native_context_length ?? upload?.context_length;
    if (typeof p.num_ctx === "number" && max) next.num_ctx = Math.min(p.num_ctx, max);
    setParams(next);
    if ("num_ctx" in p) rename(next.num_ctx);
  };

  const chooseBase = (b: string) => {
    if (kind === "host") setHostBase(b);
    else setLibBase(b);
    rename(params.num_ctx, b);
  };

  const startUpload = async (file: File) => {
    setUpload({ file: file.name, size: file.size, sent: 0, phase: "uploading" });
    let id: string | null = null;
    try {
      const start = await api<{ id: string; chunk_size: number }>(instPath(instanceId, "/models/upload"), {
        method: "POST", body: { filename: file.name, size: file.size },
      });
      id = uploadId.current = start.id;
      for (let off = 0; off < file.size; off += start.chunk_size) {
        // cancelled, or the editor closed
        if (uploadId.current !== id) return;
        const r = await fetch(instPath(instanceId, `/models/upload/${id}?offset=${off}`), {
          method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(off, off + start.chunk_size),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`);
        setUpload((u) => u && { ...u, sent: Math.min(file.size, off + start.chunk_size) });
      }
      setUpload((u) => u && { ...u, phase: "finishing" });
      const done = await api<{ digest: string; architecture: string | null; name: string | null; context_length: number | null }>(
        instPath(instanceId, `/models/upload/${id}`), { method: "POST", body: {} },
      );
      uploadId.current = null;
      setUpload((u) => u && { ...u, phase: "done", ...done });
      if (!nameTouched) setTarget(suggestName(uploadName(file.name), params.num_ctx));
    } catch (e) {
      if (uploadId.current === id) uploadId.current = null;
      setUpload((u) => u && { ...u, phase: "error", error: (e as Error).message });
    }
  };
  const cancelUpload = () => {
    if (uploadId.current) void fetch(instPath(instanceId, `/models/upload/${uploadId.current}`), { method: "DELETE" }).catch(() => {});
    uploadId.current = null;
    setUpload(null);
  };

  const save = async () => {
    const name = target.trim();
    if (!name) return toast("Enter a model name", "bad");
    const body: Record<string, unknown> = { model: name, parameters: params };
    if (isNew) {
      if (kind === "upload") {
        if (!blob) return toast("Upload a GGUF file first", "bad");
        body.blob = blob;
      } else {
        if (!base) return toast("Choose the model to start from", "bad");
        body.from = base;
        if (kind === "library") body.pull = true;
      }
      if (system.trim()) body.system = system;
      if (template.trim()) body.template = template;
    } else {
      if (name === model && !confirm(`Overwrite ${model} in place?`)) return;
      body.from = model;
      if (system !== (info?.system ?? "")) body.system = system;
      if (template !== (info?.template ?? "")) body.template = template;
    }
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
  const nctx = info?.native_context_length ?? upload?.context_length ?? null;
  const chips = [...new Set([d.family, info?.architecture, d.parameter_size, d.quantization_level].filter(Boolean) as string[])];
  const same = !isNew && target.trim() === model;
  const ready = !isNew ? !!info : kind === "upload" ? !!blob : !!base;

  return (
    <Drawer open onClose={onClose} className="editdrawer">
      <div className="drawer-head">
        <h3>{isNew ? "New model" : `Edit ${model}`}</h3>
        <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {error && <div className="notice bad">{error}</div>}
      {!isNew && !info && !error && <div className="empty">Loading…</div>}

      {isNew && (
        <>
          <h2 style={{ margin: "0 0 10px" }}>Start from</h2>
          <div className="chips" role="radiogroup" aria-label="Start from" style={{ marginBottom: 10 }}>
            {([["host", "a model on this host"], ["library", "the library or Hugging Face"], ["upload", "a GGUF file"]] as const).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={`chip${kind === k ? " acc" : ""}`}
                onClick={() => { setKind(k); setError(null); }}>{label}</button>
            ))}
          </div>
          {kind === "host" && (
            <label className="field">
              <span>Base model</span>
              <select value={hostBase} onChange={(e) => chooseBase(e.target.value)}>
                <option value="">{installed === null ? "Loading…" : installed.length ? "Choose a model…" : "No models on this host"}</option>
                {(installed ?? []).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
              <div className="hint">The new model is layered on it, so no weights are copied. It keeps the base&apos;s template, system prompt and parameters unless you set them here.</div>
            </label>
          )}
          {kind === "library" && (
            <div className="field">
              <form className="row" onSubmit={(e) => { e.preventDefault(); chooseBase(libInput.trim()); }}>
                <input className="grow" type="text" value={libInput} onChange={(e) => setLibInput(e.target.value)} onBlur={() => chooseBase(libInput.trim())}
                  placeholder="qwen3:8b, or hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M" autoComplete="off" aria-label="Model name" />
                <button className="btn" type="submit">Check</button>
              </form>
              <div className="hint">A library tag, or a GGUF on Hugging Face as hf.co/&lt;user&gt;/&lt;repo&gt;:&lt;quantization&gt;. It&apos;s pulled to this host first if it isn&apos;t there.</div>
            </div>
          )}
          {kind === "upload" && (
            <div className="field">
              {!upload || upload.phase === "error" ? (
                <>
                  <input type="file" accept=".gguf" aria-label="GGUF file" onChange={(e) => e.target.files?.[0] && startUpload(e.target.files[0])} />
                  {upload?.error && <div className="notice bad" style={{ marginTop: 8 }}>{upload.file}: {upload.error}</div>}
                  <div className="hint">The file goes through the dashboard, which keeps it in its data directory until Ollama has it.</div>
                </>
              ) : (
                <div className="meter">
                  <div className="lbl">
                    <span>{upload.file}</span>
                    <b>{upload.phase === "done" ? "uploaded" : upload.phase === "finishing" ? "sending to Ollama…" : `${fmtBytes(upload.sent)} / ${fmtBytes(upload.size)}`}</b>
                  </div>
                  <div className="bar"><i style={{ width: `${upload.phase === "uploading" ? (upload.sent / upload.size) * 100 : 100}%` }} /></div>
                  {upload.phase === "done" ? (
                    <div className="chips" style={{ marginTop: 8 }}>
                      {upload.architecture && <span className="chip">{upload.architecture}</span>}
                      {upload.name && <span className="chip">{upload.name}</span>}
                      {upload.context_length && <span className="chip acc">native ctx {fmtNum(upload.context_length)}</span>}
                      <span className="chip">{fmtBytes(upload.size)}</span>
                      <button className="ghost sm" onClick={() => setUpload(null)}>choose another</button>
                    </div>
                  ) : upload.phase === "uploading" && <button className="ghost sm" style={{ marginTop: 6 }} onClick={cancelUpload}>Cancel</button>}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {info && (
        <div className="chips" style={{ marginBottom: 14 }}>
          {chips.map((c) => <span key={c} className="chip">{c}</span>)}
          {nctx && <span className="chip acc">native ctx {fmtNum(nctx)}</span>}
          {(info.capabilities ?? []).map((c) => <span key={c} className="chip">{c}</span>)}
        </div>
      )}
      {!isNew && info && (
        <div className="notice">
          Ollama models are immutable, so edits create a model layered on top of <b>{model}</b> (no weights are copied). Saving under
          the same name replaces it in place.
        </div>
      )}

      {(isNew || info) && (
        <>
          <label className="field">
            <span>{isNew ? "Name" : "Save as"}</span>
            <input type="text" value={target} placeholder={isNew ? "e.g. qwen3:8b-coder" : undefined}
              onChange={(e) => { setTarget(e.target.value); setNameTouched(true); }} />
            {!isNew && (
              <div className="hint">
                {same ? (
                  <span style={{ color: "var(--warn)" }}>Overwrites {model} in place. If it came from the registry, a future pull will reset it.</span>
                ) : (
                  <>New model; <b>{model}</b> stays untouched.</>
                )}
              </div>
            )}
          </label>

          <h2 style={{ margin: "18px 0 10px" }}>Presets</h2>
          <div className="chips" style={{ marginBottom: 6 }}>
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="btn sm" title={`${p.hint}: ${Object.entries(p.params).map(([k, v]) => `${k} ${v}`).join(", ")}`}
                onClick={() => applyPreset(p.params)}>{p.label}</button>
            ))}
          </div>
          <div className="hint">A preset sets only the parameters it lists; edit them below.</div>

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
          <h2 style={{ margin: "18px 0 10px" }}>Parameters</h2>
          {Object.keys(params).length === 0 && (
            <div className="hint">{isNew ? "None set: the model keeps its base's parameters, or Ollama's defaults." : "No parameters set — the model uses Ollama defaults."}</div>
          )}
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
            <summary className="sub" style={{ cursor: "pointer" }}>Template</summary>
            <textarea rows={8} style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 12.5 }} value={template} onChange={(e) => setTemplate(e.target.value)}
              placeholder={isNew ? "(inherited from the base; for a GGUF file, Ollama uses the chat template inside it)" : "(none)"} />
            <div className="hint">The Go template that turns messages into the prompt. Leave it unless the model needs a different chat format.</div>
          </details>

          {!isNew && (
            <details style={{ marginTop: 16 }}>
              <summary className="sub" style={{ cursor: "pointer" }}>Current parameters (raw)</summary>
              <pre className="logs" style={{ marginTop: 8 }}>{info?.parameters_raw || "(none)"}</pre>
            </details>
          )}

          <h2 style={{ margin: "22px 0 10px" }}>Fit estimate</h2>
          {base || blob ? (
            <FitPanel key={blob ?? base} instanceId={instanceId} model={base || "uploaded model"} blob={blob} params={params}
              onContext={(n) => setParam("num_ctx", n)} />
          ) : (
            <div className="hint">Choose the model to start from to see whether it fits.</div>
          )}

          <div className="row" style={{ marginTop: 20, justifyContent: "flex-end" }}>
            <button className="ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={!ready || !target.trim()}>
              {isNew && kind === "library" ? "Pull if needed and create" : "Create model"}
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}
