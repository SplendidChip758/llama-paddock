"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { api, fmtBytes, instPath } from "@/lib/format";
import { splitText } from "@/lib/split";
import type { BenchCase, BenchCaseSummary, BenchMode, BenchRun, BenchStat, BenchmarkInfo, TagModel } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Modal } from "./ui";

const CASES: { id: BenchCase; name: string; what: string }[] = [
  { id: "short", name: "Short prompt", what: "a short question: first token and generation speed" },
  { id: "long_context", name: "Long context", what: "reading a long prompt: prompt speed" },
  { id: "long_generation", name: "Long generation", what: "writing a long answer: generation speed" },
];
const caseName = (c: BenchCase) => CASES.find((x) => x.id === c)!.name;

/** Speeds that vary more than this between runs get flagged; the server's warning uses the same figure. */
const NOISY_CV = 10;

const rate = (n: number | null | undefined) => (n == null ? "–" : n >= 100 ? n.toFixed(0) : n.toFixed(1));
const secs = (ms: number | null | undefined) => (ms == null ? "–" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** A median, with the spread over the runs on hover, and flagged when the runs disagree. */
function StatCell({ s, fmt, best }: { s: BenchStat | null | undefined; fmt: (n: number) => string; best?: boolean }) {
  if (!s) return <span className="faint">–</span>;
  const noisy = s.cv != null && s.cv > NOISY_CV;
  const spread = s.min === s.max ? "" : `${fmt(s.min)} – ${fmt(s.max)}`;
  return (
    <span className="num" title={[spread && `range ${spread}`, s.cv != null && `varies ${s.cv.toFixed(1)}% between runs`].filter(Boolean).join(", ")}>
      <span className={best ? "bench-best" : ""}>{fmt(s.median)}</span>
      {s.cv != null && <span className={`bench-cv ${noisy ? "warn-text" : "faint"}`}> ±{s.cv < 1 ? s.cv.toFixed(1) : Math.round(s.cv)}%</span>}
    </span>
  );
}

const summaryOf = (b: BenchmarkInfo, c: BenchCase) => b.summary.find((s) => s.case === c);

function progressOf(b: BenchmarkInfo) {
  const done = b.summary.reduce((s, x) => s + x.runs + x.excluded, 0);
  return { done, total: b.spec.repeat * b.spec.cases.length };
}

function StateChip({ b }: { b: BenchmarkInfo }) {
  if (b.state === "running") {
    const { done, total } = progressOf(b);
    return <span className="chip acc">running {done}/{total}</span>;
  }
  if (b.state === "error") return <span className="chip bad" title={b.error ?? ""}>failed</span>;
  if (b.state === "cancelled") return <span className="chip warn">cancelled</span>;
  return b.warnings.length
    ? <span className="chip warn" title={b.warnings.join("\n")}>{plural(b.warnings.length, "warning")}</span>
    : <span className="chip ok">done</span>;
}

export function BenchmarksView() {
  const { loaded, readOnly } = usePaddock();
  const [list, setList] = useState<BenchmarkInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  /** the results open in the modal: one row clicked, or the ticked ones compared */
  const [viewing, setViewing] = useState<string[] | null>(null);
  const [model, setModel] = useState("");

  const load = useCallback(() => {
    api<{ benchmarks: BenchmarkInfo[] }>("/api/benchmarks?limit=500")
      .then((d) => {
        setList(d.benchmarks);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(load, [load]);
  // follow running benchmarks: every run is saved as it finishes
  const running = !!list?.some((b) => b.state === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [running, load]);

  const models = useMemo(() => [...new Set((list ?? []).map((b) => b.model))].sort(), [list]);
  const shown = (list ?? []).filter((b) => !model || b.model === model);
  const pick = (ids: string[]) => ids.map((id) => list?.find((b) => b.id === id)).filter((b): b is BenchmarkInfo => !!b);
  // looked up on every render, so a running benchmark fills in while it's open
  const viewed = viewing ? pick(viewing) : [];
  const chosen = pick(selected);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const started = (bs: BenchmarkInfo[]) => {
    setSelected(bs.map((b) => b.id));
    load();
  };

  if (!loaded) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Benchmarks</h1>
          <div className="sub">
            The same prompts, run several times, with the conditions they ran under. Pick results below to compare hosts, models,
            quantizations, or one host over time.
          </div>
        </div>
      </div>

      {readOnly ? <div className="notice">Running a benchmark loads models on the host, so it needs an admin account. You can still compare saved results.</div>
        : <RunForm onStarted={started} />}

      {error && <div className="notice bad">{error}</div>}

      {viewed.length > 0 && <ResultsModal items={viewed} onClose={() => setViewing(null)} onChanged={load} />}

      <div className="card">
        <div className="card-head">
          <h3>{list ? plural(shown.length, "result") : "Results"}</h3>
          <div className="row">
            {chosen.length > 0 && <button className="ghost sm" onClick={() => setSelected([])}>Clear</button>}
            <button className="btn primary sm" onClick={() => setViewing(chosen.map((b) => b.id))} disabled={chosen.length < 2}
              title={chosen.length < 2 ? "Tick two or more results to compare them" : ""}>
              Compare{chosen.length ? ` (${chosen.length})` : ""}
            </button>
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
              <option value="">All models</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="ghost sm" onClick={load}>Refresh</button>
          </div>
        </div>
        {list === null ? <div className="empty">{error ? "Couldn't load benchmarks" : "Loading benchmarks…"}</div>
          : !shown.length ? <div className="empty">No benchmarks yet{readOnly ? "." : " — run one above."}</div>
          : <ResultsTable items={shown} selected={selected} onToggle={toggle} onOpen={(id) => setViewing([id])} onChanged={load} />}
      </div>
    </>
  );
}

// ============================================================================ starting one
function RunForm({ onStarted }: { onStarted: (bs: BenchmarkInfo[]) => void }) {
  const { instances, toast, refreshJobs } = usePaddock();
  // models on each host, for picking the hosts that have the chosen one
  const [tags, setTags] = useState<Map<string, TagModel[]> | null>(null);
  const [model, setModel] = useState("");
  const [hosts, setHosts] = useState<string[]>([]);
  const [numCtx, setNumCtx] = useState("4096");
  const [repeat, setRepeat] = useState("3");
  const [mode, setMode] = useState<BenchMode>("warm");
  const [busy, setBusy] = useState(false);

  const ids = instances.map((i) => i.id).join("\n");
  useEffect(() => {
    let live = true;
    const list = ids ? ids.split("\n") : [];
    Promise.allSettled(list.map((id) => api<{ models: TagModel[] }>(instPath(id, "/models")))).then((rs) => {
      if (!live) return;
      // cloud models run remotely, so there is nothing on the host to measure
      setTags(new Map(list.map((id, i) => [id, rs[i].status === "fulfilled" ? rs[i].value.models.filter((m) => !m.cloud) : []])));
    });
    return () => {
      live = false;
    };
  }, [ids]);

  const has = (host: string, m: string) => !!tags?.get(host)?.some((t) => t.name === m);
  const models = useMemo(() => {
    const n = new Map<string, number>();
    for (const list of tags?.values() ?? []) for (const t of list) n.set(t.name, (n.get(t.name) ?? 0) + 1);
    return [...n].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tags]);

  // start on a model and the first host that has it
  useEffect(() => {
    if (model || !models.length) return;
    const m = models[0][0];
    setModel(m);
    setHosts(instances.filter((i) => has(i.id, m)).slice(0, 1).map((i) => i.id));
  }, [models]);

  const pickModel = (m: string) => {
    setModel(m);
    setHosts((hs) => {
      const keep = hs.filter((h) => has(h, m));
      return keep.length ? keep : instances.filter((i) => has(i.id, m)).slice(0, 1).map((i) => i.id);
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ benchmarks: BenchmarkInfo[] }>("/api/benchmarks", {
        method: "POST", body: { model, instances: hosts, num_ctx: Number(numCtx), repeat: Number(repeat), mode },
      });
      toast(`Benchmark started on ${plural(r.benchmarks.length, "host")}`, "ok");
      void refreshJobs();
      onStarted(r.benchmarks);
    } catch (err) {
      toast((err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  const withModel = instances.filter((i) => has(i.id, model));
  const runs = Number(repeat) * CASES.length;

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 16 }}>
      <div className="card-head"><h3>Run a benchmark</h3></div>
      {!instances.length ? <div className="empty">No hosts yet. <Link href="/">Add one on the overview</Link>.</div> : (
        <>
          <div className="grid g2">
            <label className="field">
              <span>Model</span>
              <select value={model} onChange={(e) => pickModel(e.target.value)} disabled={!models.length}>
                {tags === null ? <option value="">loading models…</option>
                  : !models.length ? <option value="">no models on any host</option>
                  : models.map(([m, n]) => <option key={m} value={m}>{m}{instances.length > 1 ? ` (${plural(n, "host")})` : ""}</option>)}
              </select>
            </label>
            <div className="field">
              <span className="fieldlabel">Hosts</span>
              <div className="chips">
                {instances.map((i) => (
                  <label key={i.id} className={`chip ${hosts.includes(i.id) ? "acc" : ""}`} title={has(i.id, model) ? "" : `${model} isn't on this host`}>
                    <input type="checkbox" checked={hosts.includes(i.id)} disabled={!has(i.id, model)}
                      onChange={(e) => setHosts((hs) => (e.target.checked ? [...hs, i.id] : hs.filter((h) => h !== i.id)))} /> {i.name}
                  </label>
                ))}
                {withModel.length > 1 && (
                  <button type="button" className="ghost sm" onClick={() => setHosts(withModel.map((i) => i.id))}>All {withModel.length} with it</button>
                )}
              </div>
            </div>
            <label className="field">
              <span>Context (num_ctx)</span>
              <input type="number" min={512} max={262144} step={512} value={numCtx} onChange={(e) => setNumCtx(e.target.value)} />
              <div className="hint">Sent with every run, so every host runs the model at the same size.</div>
            </label>
            <label className="field">
              <span>Repetitions</span>
              <input type="number" min={1} max={10} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
              <div className="hint">Each of the {CASES.length} prompts this many times: {runs > 0 ? plural(runs, "run") : "–"} per host.</div>
            </label>
            <label className="field">
              <span>Model state</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as BenchMode)}>
                <option value="warm">Warm: load it once, then time the answers</option>
                <option value="cold">Cold: unload it before every run, so each includes loading</option>
              </select>
            </label>
          </div>
          <div className="row">
            <span className="grow hint">
              Prompts: {CASES.map((c) => `${c.name.toLowerCase()} (${c.what})`).join(", ")}. A benchmark keeps the host busy:
              other requests to it slow both down.
            </span>
            <button className="btn primary" type="submit" disabled={busy || !model || !hosts.length}>
              {hosts.length > 1 ? `Run on ${hosts.length} hosts` : "Run"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

// ============================================================================ the list
/** Cancel a running benchmark, or delete a finished one after asking. Resolves true once it's gone. */
function useRemove(onChanged: () => void) {
  const { toast, refreshJobs } = usePaddock();
  return (b: BenchmarkInfo): Promise<boolean> => {
    if (b.state !== "running" && !confirm(`Delete this benchmark of ${b.model} on ${b.instance_name}?`)) return Promise.resolve(false);
    return api(`/api/benchmarks/${b.id}`, { method: "DELETE" })
      .then(() => {
        onChanged();
        void refreshJobs();
        return true;
      })
      .catch((e) => {
        toast((e as Error).message, "bad");
        return false;
      });
  };
}

function ResultsTable({ items, selected, onToggle, onOpen, onChanged }: {
  items: BenchmarkInfo[]; selected: string[]; onToggle: (id: string) => void; onOpen: (id: string) => void; onChanged: () => void;
}) {
  const { readOnly } = usePaddock();
  const remove = useRemove(onChanged);
  // a click anywhere on a row opens it, except on the row's own checkbox and buttons
  const rowClick = (e: MouseEvent, id: string) => {
    if (!(e.target as HTMLElement).closest("input, button, a, label")) onOpen(id);
  };

  return (
    <div className="tablewrap">
      <table className="bench-results">
        <thead>
          <tr>
            <th><span className="sr-only">Compare</span></th>
            <th>When</th><th>Host</th><th>Model</th><th>Set-up</th>
            <th className="r" title="Short prompt: generation speed">Short tok/s</th>
            <th className="r" title="Short prompt: time to the first token">First token</th>
            <th className="r" title="Long context: prompt reading speed">Prompt tok/s</th>
            <th className="r" title="Long generation: generation speed">Long gen tok/s</th>
            <th>Status</th><th />
          </tr>
        </thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.id} className={selected.includes(b.id) ? "selected" : ""} onClick={(e) => rowClick(e, b.id)}>
              <td><input type="checkbox" checked={selected.includes(b.id)} onChange={() => onToggle(b.id)} aria-label={`Compare ${b.model} on ${b.instance_name}`} /></td>
              <td className="faint num">{when(b.started)}</td>
              <td>{b.instance_name}</td>
              <td><button type="button" className="linkbtn name" onClick={() => onOpen(b.id)}>{b.model}</button>{b.conditions?.quantization && <span className="faint"> · {b.conditions.quantization}</span>}</td>
              <td className="faint">{b.spec.mode} · {b.spec.num_ctx} ctx · ×{b.spec.repeat}</td>
              <td className="r"><StatCell s={summaryOf(b, "short")?.tps} fmt={rate} /></td>
              <td className="r"><StatCell s={summaryOf(b, "short")?.ttft_ms} fmt={secs} /></td>
              <td className="r"><StatCell s={summaryOf(b, "long_context")?.prompt_tps} fmt={rate} /></td>
              <td className="r"><StatCell s={summaryOf(b, "long_generation")?.tps} fmt={rate} /></td>
              <td><StateChip b={b} /></td>
              <td>
                {!readOnly && (
                  <button className="ghost sm" onClick={() => remove(b)} title={b.state === "running" ? "Stop it; the finished runs are kept" : "Delete this result"}>
                    {b.state === "running" ? "Cancel" : "Delete"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================ comparing
type Row = { label: string; values: ReactNode[]; differs?: boolean };

/** Conditions as label → text, so the columns can be checked for differences row by row. */
function conditionRows(items: BenchmarkInfo[]): { label: string; values: string[]; key?: boolean }[] {
  const c = (f: (b: BenchmarkInfo) => string | number | null | undefined) => items.map((b) => {
    const v = f(b);
    return v == null || v === "" ? "–" : String(v);
  });
  const envKeys = [...new Set(items.flatMap((b) => Object.keys(b.conditions?.env ?? {})))].sort();
  return [
    // key: a difference here means the speeds measure different things
    { label: "Model digest", values: c((b) => b.conditions?.digest?.slice(0, 12)), key: true },
    { label: "Quantization", values: c((b) => b.conditions?.quantization), key: true },
    { label: "Parameters", values: c((b) => b.conditions?.parameter_size) },
    { label: "Prompt set", values: c((b) => b.spec.set), key: true },
    { label: "Model state", values: c((b) => b.spec.mode), key: true },
    { label: "Context asked", values: c((b) => b.spec.num_ctx), key: true },
    { label: "Context loaded", values: c((b) => b.conditions?.context) },
    { label: "Repetitions", values: c((b) => b.spec.repeat) },
    { label: "Ollama", values: c((b) => b.conditions?.ollama_version) },
    { label: "GPUs", values: c((b) => {
      const g = b.conditions?.gpus;
      if (!g) return null;
      return g.length ? g.map((x) => `${x.name}${x.mem_total_mib ? ` ${fmtBytes(x.mem_total_mib * 1048576, 0)}` : ""}`).join(", ") : "none";
    }) },
    { label: "Driver", values: c((b) => [...new Set(b.conditions?.gpus?.map((g) => g.driver) ?? [])].join(", ")) },
    { label: "CPUs / RAM", values: c((b) => b.conditions?.cpu_count != null ? `${b.conditions.cpu_count} / ${fmtBytes(b.conditions.mem_total, 0)}` : null) },
    ...envKeys.map((k) => ({ label: k, values: c((b) => (b.conditions?.env ? b.conditions.env[k] ?? "default" : null)) })),
    { label: "Other models loaded", values: c((b) => b.conditions?.other_models.join(", ") || "none") },
    { label: "Agent", values: c((b) => b.conditions?.agent_version) },
    { label: "Dashboard", values: c((b) => b.conditions?.dashboard_version) },
  ];
}

const differs = (values: string[]) => new Set(values.filter((v) => v !== "–")).size > 1;

function ResultsModal({ items, onClose, onChanged }: { items: BenchmarkInfo[]; onClose: () => void; onChanged: () => void }) {
  const { readOnly } = usePaddock();
  const remove = useRemove(onChanged);
  const [runs, setRuns] = useState<Map<string, BenchRun[]> | null>(null);
  const cases = BENCH_ORDER.filter((c) => items.some((b) => b.spec.cases.includes(c)));
  const conds = conditionRows(items);
  const keyDiffs = conds.filter((r) => r.key && differs(r.values)).map((r) => r.label.toLowerCase());

  // the highest rate, or the shortest time, of a row: only worth marking with something to compare
  const best = (vals: (number | null | undefined)[], high: boolean) => {
    const xs = vals.filter((x): x is number => x != null);
    // a tie has no best one
    return items.length > 1 && new Set(xs).size > 1 ? (high ? Math.max(...xs) : Math.min(...xs)) : null;
  };
  const speedRows = (c: BenchCase): Row[] => {
    const s = items.map((b) => summaryOf(b, c));
    const row = (label: string, pick: (x: BenchCaseSummary) => BenchStat | null, fmt: (n: number) => string, high: boolean): Row => {
      const medians = s.map((x) => (x ? pick(x)?.median : null));
      const b = best(medians, high);
      // judged as shown: two figures that round to the same text are a tie, not a win
      const shown = medians.filter((m): m is number => m != null).map(fmt);
      const win = b != null && new Set(shown).size > 1 ? fmt(b) : null;
      return { label, values: s.map((x, i) => (x ? <StatCell s={pick(x)} fmt={fmt} best={win != null && medians[i] != null && fmt(medians[i]!) === win} /> : <span className="faint">not run</span>)) };
    };
    return [
      row("Generation tok/s", (x) => x.tps, rate, true),
      row("Prompt tok/s", (x) => x.prompt_tps, rate, true),
      row("First token", (x) => x.ttft_ms, secs, false),
      row("Load", (x) => x.load_ms, secs, false),
      { label: "Tokens (prompt / answer)", values: s.map((x) => <span className="num faint">{x?.prompt_tokens ?? "–"} / {x?.tokens ?? "–"}</span>) },
      { label: "VRAM · split", values: s.map((x) => <span className="faint">{x?.size_vram != null ? fmtBytes(x.size_vram) : "–"}{x?.split ? ` · ${splitText(x.split)}` : ""}</span>) },
    ];
  };

  const showRuns = () => {
    Promise.all(items.map((b) => api<BenchmarkInfo>(`/api/benchmarks/${b.id}`)))
      .then((ds) => setRuns(new Map(ds.map((d) => [d.id, d.runs ?? []]))))
      .catch(() => setRuns(new Map()));
  };

  const one = items.length === 1 ? items[0] : null;
  // a subtitle only when every result shares it, as when comparing hosts with one model and set-up
  const same = (f: (b: BenchmarkInfo) => string) => (new Set(items.map(f)).size === 1 ? f(items[0]) : null);
  const subtitle = one
    ? `${when(one.started)} · ${one.spec.mode} · ${one.spec.num_ctx} ctx · ${plural(one.spec.repeat, "run")} per prompt`
    : [same((b) => b.model), same((b) => `${b.spec.mode} · ${b.spec.num_ctx} ctx · ${plural(b.spec.repeat, "run")} per prompt`)].filter(Boolean).join(" · ");

  return (
    <Modal onClose={onClose} labelledBy="bench-modal-title" className="bench-modal">
      <div className="modal-head">
        <div className="grow" style={{ flex: 1, minWidth: 0 }}>
          <h2 id="bench-modal-title">
            {one ? <>{one.instance_name} · {one.model} <StateChip b={one} /></> : `Comparing ${items.length} results`}
          </h2>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        <button className="ghost sm" onClick={runs ? () => setRuns(null) : showRuns} aria-pressed={!!runs}>{runs ? "Hide runs" : "Show runs"}</button>
        <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="modal-body">
        {keyDiffs.length > 0 && (
          <div className="notice warn">
            These ran with a different {keyDiffs.join(", ")}, so their speeds don&apos;t measure the same thing. Compare them with care.
          </div>
        )}
        <div className="tablewrap">
          <table className="bench-compare">
            {/* one result: its host, model and date are already in the title */}
            {!one && (
              <thead>
                <tr>
                  <th />
                  {items.map((b) => (
                    <th key={b.id} style={{ textTransform: "none" }}>
                      <div>{b.instance_name}</div>
                      <div className="faint" style={{ fontWeight: 400 }}>{b.model} · {when(b.started)}</div>
                      <StateChip b={b} />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {cases.map((c) => (
                <Fragment key={c}>
                  <tr className="bench-group"><th colSpan={items.length + 1}>{caseName(c)}</th></tr>
                  {speedRows(c).map((r) => (
                    <tr key={r.label}><td className="faint">{r.label}</td>{r.values.map((v, i) => <td key={i}>{v}</td>)}</tr>
                  ))}
                </Fragment>
              ))}
              <tr className="bench-group"><th colSpan={items.length + 1}>Conditions</th></tr>
              {conds.map((r) => {
                const d = items.length > 1 && differs(r.values);
                return (
                  <tr key={r.label} className={d ? "bench-differs" : ""}>
                    <td className="faint">{r.label}{d && <span className="chip warn" style={{ marginLeft: 6 }}>differs</span>}</td>
                    {r.values.map((v, i) => <td key={i} className="mono">{v}</td>)}
                  </tr>
                );
              })}
              <tr>
                <td className="faint">Warnings</td>
                {items.map((b) => (
                  <td key={b.id}>
                    {b.error && <div className="bad-text">{b.error}</div>}
                    {b.warnings.length ? <ul className="bench-warnings">{b.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : !b.error && <span className="faint">none</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {runs && items.map((b) => <RunsTable key={b.id} b={b} runs={runs.get(b.id) ?? []} />)}
      </div>
      <div className="modal-foot">
        {one && !readOnly && (
          // cancelling keeps the finished runs, so the result stays open; a deleted one is gone
          <button className={one.state === "running" ? "ghost sm" : "danger sm"}
            onClick={() => void remove(one).then((gone) => gone && one.state !== "running" && onClose())}
            title={one.state === "running" ? "Stop it; the finished runs are kept" : "Delete this result"}>
            {one.state === "running" ? "Cancel benchmark" : "Delete result"}
          </button>
        )}
        <span className="grow faint" style={{ fontSize: 12.5 }}>{items.length > 1 ? "The best median is in green. ± is how much the runs varied." : "± is how much the runs varied."}</span>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

const BENCH_ORDER: BenchCase[] = CASES.map((c) => c.id);

function RunsTable({ b, runs }: { b: BenchmarkInfo; runs: BenchRun[] }) {
  return (
    <div style={{ marginTop: 16 }}>
      <h4>{b.instance_name} · {b.model} <span className="faint" style={{ fontWeight: 400 }}>{plural(runs.length, "run")}</span></h4>
      {!runs.length ? <div className="empty">No finished runs.</div> : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Prompt</th><th className="r">#</th><th>Found</th><th className="r">Gen tok/s</th><th className="r">Prompt tok/s</th>
                <th className="r">First token</th><th className="r">Load</th><th className="r">Tokens</th><th className="r">VRAM</th><th>Split</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={i} className={r.state === b.spec.mode ? "" : "faint"} title={r.state === b.spec.mode ? "" : "left out of the figures: the model wasn't in the state this benchmark asks for"}>
                  <td>{caseName(r.case)}</td>
                  <td className="r num">{r.rep}</td>
                  <td>{r.state}</td>
                  <td className="r num">{rate(r.stats.tps)}</td>
                  <td className="r num">{rate(r.stats.prompt_tps)}</td>
                  <td className="r num">{secs(r.stats.ttft_ms)}</td>
                  <td className="r num">{secs(r.stats.load_ms)}</td>
                  <td className="r num">{r.stats.prompt_tokens ?? "–"} / {r.stats.tokens ?? "–"}</td>
                  <td className="r num">{r.size_vram != null ? fmtBytes(r.size_vram) : "–"}</td>
                  <td>{r.split ? splitText(r.split) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
