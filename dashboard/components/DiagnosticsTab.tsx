"use client";

import { fmtNum } from "@/lib/format";
import { isOffloaded, splitHint, splitText } from "@/lib/split";
import type { InstanceSnapshot } from "@/lib/types";
import { GpuCheckCard } from "./GpuCheck";

export function DiagnosticsTab({ st }: { st: InstanceSnapshot }) {
  const offloaded = st.ps.filter((m) => isOffloaded(m.split));
  const models = st.ps.filter((m) => m.split.state !== "cloud");
  return (
    <>
      <h2>GPU check</h2>
      {st.gpu_check ? <GpuCheckCard st={st} /> : (
        <div className="notice">The GPU check needs an online agent with NVIDIA GPU telemetry. No result is available yet.</div>
      )}
      <div className="section">
        <h2>Model placement</h2>
        <p className="hint">CPU placement can be intentional. Use these checks if you expected the model to use more GPU memory.</p>
        {!st.ollama_ok ? <div className="empty">Ollama is unreachable</div> : offloaded.length ? (
          <div className="grid g2">
            {offloaded.map((m) => (
              <div className="card" key={m.name}>
                <div className="card-head"><h3>{m.name}</h3><span className="chip">{splitText(m.split, true)}</span></div>
                <p className="hint">{splitHint(m.split)}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="notice">No loaded model is reported as partly or fully on the CPU. See Monitor for live placement readings.</div>
        )}
      </div>
      <div className="section">
        <h2>Context allocation</h2>
        <p className="hint">Active is the context allocated to the loaded model, not the number of tokens used by a prompt.
          Configured is the Modelfile or host setting; model maximum is what the model supports. A smaller allocation can be intentional.</p>
        {!st.ollama_ok ? <div className="empty">Ollama is unreachable</div> : !models.length ? (
          <div className="empty">No local models loaded</div>
        ) : (
          <div className="grid g2">
            {models.map((m) => {
              const c = m.context;
              return (
                <div className="card" key={m.name}>
                  <div className="card-head">
                    <h3>{m.name}</h3>
                    {c?.state === "short" && <span className="chip warn">Below configured context</span>}
                  </div>
                  <dl className="kv">
                    <dt>Active</dt><dd>{fmtNum(c?.running ?? m.context_length)} tokens</dd>
                    <dt>Configured</dt><dd>{c?.configured != null ? `${fmtNum(c.configured)} tokens` : "Not reported"}</dd>
                    {c?.configured_by && <><dt>Setting</dt><dd>{c.configured_by === "modelfile" ? "Modelfile num_ctx" : "OLLAMA_CONTEXT_LENGTH"}</dd></>}
                    <dt>Model maximum</dt><dd>{c?.max != null ? `${fmtNum(c.max)} tokens` : "Not reported"}</dd>
                  </dl>
                  {c?.hint && <p className="hint">{c.hint}</p>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="section">
        <h2>Model reloads</h2>
        {st.reload_churn.length ? (
          <div className="notice warn reload-notice">
            {st.reload_churn.map((x) => (
              <div key={x.model ?? ""}>
                <b>{x.summary}</b> Each load makes requests wait.
                {x.causes.length > 0 && <ul>{x.causes.map((y) => <li key={y}>{y}</li>)}</ul>}
                {x.fixes.length > 0 && <div className="hint">{x.fixes.join(" ")}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="notice">No frequent reloads detected in the available observations. Polling can miss short-lived loads; agent logs add evidence where available.</div>
        )}
      </div>
    </>
  );
}
