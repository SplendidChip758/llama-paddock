"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, instPath } from "@/lib/format";
import type { ChatMessage, PromptEvent, PromptStats, TagModel } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Stat } from "./ui";

interface Turn {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  stats?: PromptStats;
  error?: string;
  /** performance.now() when the request went out, while the answer is still coming */
  started?: number;
}

interface Column {
  key: number;
  host: string;
  model: string;
  turns: Turn[];
}

const secs = (ms: number | null | undefined) => (ms == null ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const tps = (n: number | null | undefined) => (n == null ? "–" : n >= 100 ? n.toFixed(0) : n.toFixed(1));

/** POST a test prompt and hand each streamed event to `on`. Errors before the stream starts are thrown. */
async function runPrompt(host: string, body: unknown, signal: AbortSignal, on: (e: PromptEvent) => void) {
  const r = await fetch(instPath(host, "/chat"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal, cache: "no-store",
  });
  if (!r.ok || !r.body) {
    // api() handles an expired session; a failed prompt only needs its message
    if (r.status === 401) window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    const d = await r.json().catch(() => null);
    throw new Error(d?.detail ?? `HTTP ${r.status}`);
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) on(JSON.parse(line));
    }
  }
}

export function PromptView({ host, model }: { host?: string; model?: string }) {
  const { instances, loaded, readOnly } = usePaddock();
  const nextKey = useRef(1);
  const [columns, setColumns] = useState<Column[]>([{ key: 0, host: host ?? "", model: model ?? "", turns: [] }]);
  const [system, setSystem] = useState("");
  const [text, setText] = useState("");
  const [running, setRunning] = useState<AbortController | null>(null);
  // re-render while waiting so the "waiting for first token" timer moves
  const [, setTick] = useState(0);

  // until a host is chosen, start on the first one
  useEffect(() => {
    if (!columns[0].host && instances.length) setColumns((cs) => cs.map((c, i) => (i === 0 && !c.host ? { ...c, host: instances[0].id } : c)));
  }, [instances, columns]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(t);
  }, [running]);

  const update = (key: number, fn: (c: Column) => Column) => setColumns((cs) => cs.map((c) => (c.key === key ? fn(c) : c)));
  const lastTurn = (key: number, fn: (t: Turn) => Turn) =>
    update(key, (c) => ({ ...c, turns: c.turns.map((t, i) => (i === c.turns.length - 1 ? fn(t) : t)) }));

  const addColumn = () => {
    const other = instances.find((i) => i.id !== columns[0].host) ?? instances[0];
    setColumns((cs) => [...cs, { key: nextKey.current++, host: other?.id ?? "", model: cs[0].model, turns: [] }]);
  };

  const ask = async (col: Column, prompt: string, signal: AbortSignal) => {
    // a question whose answer failed or was stopped is left out, with its partial answer
    const history: ChatMessage[] = [];
    for (let i = 0; i + 1 < col.turns.length; i += 2) {
      const [q, a] = [col.turns[i], col.turns[i + 1]];
      if (!a.error) history.push({ role: "user", content: q.content }, { role: "assistant", content: a.content });
    }
    const messages: ChatMessage[] = [...(system.trim() ? [{ role: "system" as const, content: system }] : []), ...history, { role: "user", content: prompt }];
    update(col.key, (c) => ({ ...c, turns: [...c.turns, { role: "user", content: prompt }, { role: "assistant", content: "", started: performance.now() }] }));
    try {
      await runPrompt(col.host, { model: col.model, messages }, signal, (e) => {
        if (e.type === "token") lastTurn(col.key, (t) => ({ ...t, content: t.content + e.content, thinking: e.thinking ? (t.thinking ?? "") + e.thinking : t.thinking }));
        else if (e.type === "done") lastTurn(col.key, (t) => ({ ...t, stats: e.stats, started: undefined }));
        else lastTurn(col.key, (t) => ({ ...t, error: e.detail, started: undefined }));
      });
      lastTurn(col.key, (t) => (t.started && !t.error ? { ...t, error: "the answer ended early", started: undefined } : t));
    } catch (e) {
      const msg = signal.aborted ? "stopped" : (e as Error).message;
      lastTurn(col.key, (t) => ({ ...t, error: msg, started: undefined }));
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const prompt = text.trim();
    const ready = columns.filter((c) => c.host && c.model);
    if (!prompt || running || !ready.length) return;
    setText("");
    const ctl = new AbortController();
    setRunning(ctl);
    // Columns on different hosts run at once. Two on the same host take turns, so neither
    // answer's speed is measured while the host is busy with the other.
    const byHost = new Map<string, Column[]>();
    for (const c of ready) byHost.set(c.host, [...(byHost.get(c.host) ?? []), c]);
    await Promise.all([...byHost.values()].map(async (cols) => {
      for (const c of cols) if (!ctl.signal.aborted) await ask(c, prompt, ctl.signal);
    }));
    setRunning(null);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
  };

  if (!loaded) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Test prompt</h1>
          <div className="sub">Chat with a model and see how fast the host answers. Add a column to compare hosts or models side by side.</div>
        </div>
        <div className="actions">
          {columns.length < 2 && <button className="btn" onClick={addColumn} disabled={!instances.length}>Compare</button>}
          <button className="ghost" disabled={!!running || columns.every((c) => !c.turns.length)}
            onClick={() => setColumns((cs) => cs.map((c) => ({ ...c, turns: [] })))}>Clear</button>
        </div>
      </div>

      {readOnly && <div className="notice">Running a prompt loads models on the host, so it needs an admin account.</div>}
      {!instances.length && <div className="notice">No hosts yet. <Link href="/">Add one on the overview</Link>.</div>}

      <div className={`grid ${columns.length > 1 ? "g2" : ""}`}>
        {columns.map((c) => (
          <PromptColumn key={c.key} col={c} busy={!!running}
            onHost={(h) => update(c.key, (x) => ({ ...x, host: h, model: "", turns: [] }))}
            onModel={(m) => update(c.key, (x) => ({ ...x, model: m, turns: [] }))}
            onRemove={columns.length > 1 ? () => setColumns((cs) => cs.filter((x) => x.key !== c.key)) : undefined} />
        ))}
      </div>

      <form className="card prompt-compose" onSubmit={send}>
        <details>
          <summary className="faint">System prompt{system.trim() && " (set)"}</summary>
          <textarea value={system} onChange={(e) => setSystem(e.target.value)} placeholder="Optional instructions sent before the conversation"
            style={{ minHeight: 60, marginTop: 8 }} />
        </details>
        <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} disabled={readOnly}
          placeholder="Ask something… (Ctrl+Enter to send)" aria-label="Prompt" />
        <div className="row">
          <span className="grow hint">
            First token is timed by the dashboard and includes loading the model. Other figures are Ollama&apos;s own.
          </span>
          {running ? (
            <button className="btn" type="button" onClick={() => running.abort()}>Stop</button>
          ) : (
            <button className="btn primary" type="submit" disabled={readOnly || !text.trim() || !columns.some((c) => c.host && c.model)}>Send</button>
          )}
        </div>
      </form>
    </>
  );
}

function PromptColumn({ col, busy, onHost, onModel, onRemove }: {
  col: Column; busy: boolean; onHost: (h: string) => void; onModel: (m: string) => void; onRemove?: () => void;
}) {
  const { instances } = usePaddock();
  const [models, setModels] = useState<TagModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const st = instances.find((i) => i.id === col.host);
  const bottom = useRef<HTMLDivElement>(null);
  const last = col.turns[col.turns.length - 1];

  useEffect(() => {
    if (!col.host) return;
    let live = true;
    setModels(null);
    setError(null);
    api<{ models: TagModel[] }>(instPath(col.host, "/models"))
      .then((d) => live && setModels([...d.models].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [col.host]);

  // pick a model once the list is in: the one asked for, else one already loaded, else the first
  const ps = st?.ps;
  useEffect(() => {
    if (!models?.length || models.some((m) => m.name === col.model)) return;
    const warm = models.find((m) => ps?.some((p) => p.name === m.name));
    onModel((warm ?? models[0]).name);
  }, [models, col.model, ps, onModel]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [last?.content.length, col.turns.length]);

  const latest = [...col.turns].reverse().find((t) => t.stats)?.stats;

  return (
    <div className="card prompt-col">
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={col.host} onChange={(e) => onHost(e.target.value)} disabled={busy} aria-label="Host">
          {!col.host && <option value="">Choose a host</option>}
          {instances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <select value={col.model} onChange={(e) => onModel(e.target.value)} disabled={busy || !models?.length} aria-label="Model">
          {models === null ? <option value="">{error ? "couldn't list models" : "loading models…"}</option>
            : !models.length ? <option value="">no models on this host</option>
            : models.map((m) => <option key={m.name} value={m.name}>{m.name}{ps?.some((p) => p.name === m.name) ? " (loaded)" : ""}</option>)}
        </select>
        {onRemove && <button className="ghost sm" onClick={onRemove} disabled={busy} aria-label="Remove this column">✕</button>}
      </div>
      {error && <div className="notice bad">{error}</div>}

      <div className="stats" style={{ marginBottom: 12 }}>
        <Stat k="Generation" v={tps(latest?.tps)} unit="tok/s" />
        <Stat k="First token" v={secs(latest?.ttft_ms)} />
        <Stat k="Load" v={secs(latest?.load_ms)} />
        <Stat k="Prompt" v={tps(latest?.prompt_tps)} unit="tok/s" />
      </div>

      <div className="prompt-log">
        {!col.turns.length && <div className="empty">Send a prompt to see the answer and its timings here.</div>}
        {col.turns.map((t, i) => (
          <div key={i} className={`prompt-turn ${t.role}`}>
            {t.thinking && (
              <details className="prompt-thinking">
                <summary className="faint">thinking</summary>
                <div>{t.thinking}</div>
              </details>
            )}
            {t.content && <div className="prompt-text">{t.content}</div>}
            {t.started != null && !t.content && !t.thinking && (
              <div className="faint">waiting for the first token… {secs(performance.now() - t.started)}</div>
            )}
            {t.error && <div className="bad-text">{t.error}</div>}
            {t.stats && <TurnStats s={t.stats} />}
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function TurnStats({ s }: { s: PromptStats }) {
  const parts = [
    `${tps(s.tps)} tok/s`,
    `first token ${secs(s.ttft_ms)}`,
    s.load_ms != null && s.load_ms >= 1 ? `load ${secs(s.load_ms)}` : null,
    s.prompt_tokens != null ? `prompt ${s.prompt_tokens} tok at ${tps(s.prompt_tps)} tok/s` : null,
    s.tokens != null ? `${s.tokens} tokens` : null,
    `total ${secs(s.wall_ms)}`,
    s.done_reason && s.done_reason !== "stop" ? `stopped: ${s.done_reason}` : null,
  ];
  return <div className="prompt-stats num">{parts.filter(Boolean).join(" · ")}</div>;
}
