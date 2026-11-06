"use client";

import { useEffect, useMemo, useState } from "react";
import { api, fmtBytes, fmtNum, instPath } from "@/lib/format";
import { estimateFit } from "@/lib/fit";
import type { FitEstimate, FitResult, ParamValue } from "@/lib/types";

const VERDICT: Record<FitEstimate["verdict"], { label: string; cls: string }> = {
  fits: { label: "likely fits", cls: "ok" },
  offload: { label: "likely CPU offload", cls: "warn" },
  insufficient: { label: "insufficient capacity", cls: "bad" },
  unknown: { label: "insufficient information", cls: "" },
  cloud: { label: "cloud", cls: "cloud" },
};

const intParam = (v: ParamValue | undefined): number | null => {
  const n = Number(v);
  return v === undefined || v === "" || Array.isArray(v) || !Number.isFinite(n) ? null : Math.trunc(n);
};

export function VerdictChip({ e }: { e: FitEstimate }) {
  const v = VERDICT[e.verdict];
  return (
    <span className={`chip ${v.cls}`} title={e.confidence ? `${e.confidence} confidence` : undefined}>
      {v.label}{e.verdict === "offload" && e.gpu_pct ? ` · ${e.gpu_pct}% GPU` : ""}
    </span>
  );
}

/**
 * The model editor's fit estimate: fetched once, then re-estimated in the browser as the context and
 * parameters change, since the formula and the measurements come with the response.
 */
export function FitPanel({ instanceId, model, blob, params, onContext }: {
  instanceId: string; model: string; params: Record<string, ParamValue>; onContext: (n: number) => void;
  /** a GGUF uploaded for a new model, estimated from its header instead of `model` */
  blob?: string | null;
}) {
  const [data, setData] = useState<FitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<FitResult>(instPath(instanceId, "/models/fit"), { method: "POST", body: blob ? { model, blob } : { model } })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [instanceId, model, blob]);

  const ctx = intParam(params.num_ctx);
  const e = useMemo(() => {
    if (!data) return null;
    // the editor's parameters are what the new model's Modelfile will hold
    const m = { ...data.model, num_ctx: null, num_gpu: intParam(params.num_gpu), num_batch: intParam(params.num_batch) };
    return estimateFit(m, data.hosts[0], data.measurements, ctx);
  }, [data, ctx, params.num_gpu, params.num_batch]);

  if (error) return <div className="hint">Fit estimate unavailable: {error}</div>;
  if (!e) return <div className="hint">Estimating fit…</div>;

  return (
    <div className="fitpanel">
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <VerdictChip e={e} />
        {e.confidence && <span className="chip">{e.confidence} confidence</span>}
        <span className="sub">at {fmtNum(e.context)} tokens{e.context_source === "default" ? " (Ollama's default)" : e.context_source === "env" ? " (OLLAMA_CONTEXT_LENGTH)" : ""}</span>
      </div>
      <div>{e.summary}</div>
      {e.total !== null && e.kv !== null && (
        <div className="hint">
          Weights {fmtBytes(e.weights)} · KV cache {fmtBytes(e.kv)} · buffers {fmtBytes(e.overhead)}
          {e.calibration && e.formula_total !== null
            ? <> · formula {fmtBytes(e.formula_total)}, {e.calibration.kind === "measured" ? "measured" : "calibrated"} <b>{fmtBytes(e.total)}</b></>
            : <> = <b>{fmtBytes(e.total)}</b></>}
        </div>
      )}
      {e.max_gpu_context !== null && (
        <div className="hint">
          {e.max_gpu_context > 0 ? (
            <>
              Largest context likely fully in VRAM: <b>{fmtNum(e.max_gpu_context)}</b> tokens
              {e.max_gpu_context !== e.context && (
                <> <button className="btn sm" onClick={() => onContext(e.max_gpu_context!)}>use</button></>
              )}
            </>
          ) : "Not even a small context fits fully in VRAM."}
        </div>
      )}
      {e.evicts.length > 0 && (
        <div className="hint" style={{ color: "var(--warn)" }}>
          Won&apos;t fit beside what&apos;s loaded now: Ollama would unload {e.evicts.join(", ")} first.
        </div>
      )}
    </div>
  );
}
