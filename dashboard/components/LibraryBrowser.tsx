"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, instPath } from "@/lib/format";
import type { LibraryModel, LibrarySearch, LibraryTag } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

const CAPS = ["tools", "vision", "thinking", "embedding", "audio", "cloud"];
/** Parameter ranges to filter by, in billions. */
const PARAM_RANGES: { label: string; min: number; max: number }[] = [
  { label: "any size", min: 0, max: Infinity },
  { label: "≤ 4B", min: 0, max: 4 },
  { label: "4–9B", min: 4, max: 9 },
  { label: "9–16B", min: 9, max: 16 },
  { label: "16–36B", min: 16, max: 36 },
  { label: "36–80B", min: 36, max: 80 },
  { label: "> 80B", min: 80, max: Infinity },
];
const QUANTS = [
  { label: "any quantization", test: () => true },
  { label: "4-bit (q4…)", test: (q: string) => /^i?q4/i.test(q) || /mxfp4/i.test(q) },
  { label: "5–6-bit (q5, q6)", test: (q: string) => /^i?q[56]/i.test(q) },
  { label: "8-bit (q8, fp8)", test: (q: string) => /^q8|fp8/i.test(q) },
  { label: "16-bit (fp16, bf16)", test: (q: string) => /^(fp|bf|f)16$/i.test(q) },
];

/** Billions of parameters from a size chip or a tag: 8b, 0.6b, 135m, e4b (effective), 8x7b. */
export function paramsB(s: string): number | null {
  const m = /^(?:(\d+)x)?e?(\d+(?:\.\d+)?)([mbt])/i.exec(s);
  if (!m) return null;
  const n = Number(m[2]) * ({ m: 0.001, b: 1, t: 1000 }[m[3].toLowerCase()] ?? 1);
  return m[1] ? n * Number(m[1]) : n;
}

const fmtSize = (b: number | null) => (b === null ? "–" : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : `${Math.round(b / 1e6)} MB`);
const fmtCtx = (n: number | null) => (n === null ? "–" : n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));

/** Search the Ollama library and pull a tag to one or more hosts. */
export function LibraryBrowser({ instanceId, onClose, onPulled }: { instanceId: string; onClose: () => void; onPulled?: () => void }) {
  const { instances, toast, refreshJobs, setJobsOpen, readOnly } = usePaddock();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState<string | null>(null);
  const [sort, setSort] = useState<"popular" | "newest">("popular");
  const [range, setRange] = useState(0);
  const [quant, setQuant] = useState(0);
  const [results, setResults] = useState<LibraryModel[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([instanceId]);

  const search = useCallback(async (p: number) => {
    setLoading(true);
    const params = new URLSearchParams({ sort, page: String(p) });
    if (query) params.set("q", query);
    if (capability) params.set("capability", capability);
    try {
      const d = await api<LibrarySearch>(`/api/library?${params}`);
      setResults((prev) => (p === 1 ? d.models : [...(prev ?? []), ...d.models.filter((m) => !prev?.some((x) => x.path === m.path))]));
      setHasMore(d.has_more);
      setPage(p);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      if (p === 1) setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, capability, sort]);

  useEffect(() => {
    search(1);
  }, [search]);

  const r = PARAM_RANGES[range];
  const inRange = (s: string) => {
    const b = paramsB(s);
    return b === null || (b > r.min && b <= r.max);
  };
  const shown = (results ?? []).filter((m) => range === 0 || !m.sizes.length || m.sizes.some(inRange));

  const pull = async (name: string) => {
    if (!targets.length) return toast("Choose a host to pull to", "bad");
    const fails: string[] = [];
    for (const id of targets) {
      try {
        await api(instPath(id, "/models/pull"), { method: "POST", body: { model: name } });
      } catch (e) {
        fails.push(`${instances.find((i) => i.id === id)?.name ?? id}: ${(e as Error).message}`);
      }
    }
    if (fails.length) toast(fails.join("; "), "bad");
    if (fails.length < targets.length) {
      toast(`Pulling ${name} to ${targets.length - fails.length} host${targets.length - fails.length === 1 ? "" : "s"}…`);
      await refreshJobs();
      setJobsOpen(true);
      onPulled?.();
    }
  };

  return (
    <Drawer open onClose={onClose} className="librarydrawer">
      <div className="drawer-head">
        <h3>Ollama library</h3>
        <div className="row" style={{ gap: 10 }}>
          <a className="sub" href="https://ollama.com/library" target="_blank" rel="noopener">ollama.com ↗</a>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input className="grow" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models: qwen, coder, embed…" autoFocus />
        <button className="btn primary" type="submit">Search</button>
      </form>
      <div className="chips" style={{ margin: "10px 0" }}>
        {CAPS.map((c) => (
          <button key={c} type="button" className={`chip${capability === c ? " acc" : ""}`} aria-pressed={capability === c}
            onClick={() => setCapability(capability === c ? null : c)}>{c}</button>
        ))}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <select value={sort} onChange={(e) => setSort(e.target.value as "popular" | "newest")} aria-label="Sort">
          <option value="popular">most popular</option>
          <option value="newest">newest</option>
        </select>
        <select value={range} onChange={(e) => setRange(Number(e.target.value))} aria-label="Parameter count">
          {PARAM_RANGES.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
        </select>
        <select value={quant} onChange={(e) => setQuant(Number(e.target.value))} aria-label="Quantization">
          {QUANTS.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}
        </select>
      </div>
      {!readOnly && instances.length > 1 && (
        <div className="hint" style={{ marginBottom: 10 }}>
          Pull to:{" "}
          {instances.map((i) => (
            <label key={i.id} style={{ marginRight: 10, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={targets.includes(i.id)}
                onChange={(e) => setTargets(e.target.checked ? [...targets, i.id] : targets.filter((t) => t !== i.id))} /> {i.name}
            </label>
          ))}
        </div>
      )}

      {error && <div className="notice bad">{error} You can still pull by name on the Models tab.</div>}
      {results === null ? <div className="empty">Loading the library…</div> : shown.length === 0 && !error ? <div className="empty">No models match.</div> : null}
      <ul className="librarylist">
        {shown.map((m) => (
          <li key={m.path}>
            <button type="button" className="libraryhead" aria-expanded={open === m.path} onClick={() => setOpen(open === m.path ? null : m.path)}>
              <span className="name">{m.name}</span>
              <span className="chips">
                {m.capabilities.map((c) => <span key={c} className={`chip${c === "cloud" ? " cloud" : ""}`}>{c}</span>)}
                {m.sizes.map((s) => <span key={s} className={`chip acc${range && !inRange(s) ? " dim" : ""}`}>{s}</span>)}
              </span>
              {m.description && <span className="desc">{m.description}</span>}
              <span className="faint">
                {m.pulls !== null && `${fmtNum(m.pulls)} pulls`}{m.tag_count !== null && ` · ${m.tag_count} tags`}{m.updated && ` · updated ${m.updated}`}
              </span>
            </button>
            {open === m.path && (
              <Tags path={m.path} inRange={range ? inRange : null} quantTest={quant ? QUANTS[quant].test : null}
                onPull={readOnly ? null : pull} />
            )}
          </li>
        ))}
      </ul>
      {hasMore && <button className="btn" disabled={loading} onClick={() => search(page + 1)} style={{ width: "100%" }}>{loading ? "Loading…" : "More"}</button>}
    </Drawer>
  );
}

function Tags({ path, inRange, quantTest, onPull }: {
  path: string;
  inRange: ((s: string) => boolean) | null;
  quantTest: ((q: string) => boolean) | null;
  onPull: ((name: string) => void) | null;
}) {
  const [tags, setTags] = useState<LibraryTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ tags: LibraryTag[] }>(`/api/library/tags?model=${encodeURIComponent(path)}`)
      .then((d) => setTags(d.tags))
      .catch((e) => setError(e.message));
  }, [path]);
  if (error) return <div className="notice bad">{error}</div>;
  if (!tags) return <div className="hint">Loading tags…</div>;
  const shown = tags.filter((t) => (!inRange || inRange(t.tag)) && (!quantTest || (t.quantization !== null && quantTest(t.quantization))));
  const hidden = tags.length - shown.length;
  return (
    <div className="tablewrap">
      <table className="librarytags">
        <thead><tr><th>Tag</th><th className="r">Size</th><th className="r">Context</th><th>Input</th><th>Quant</th><th /></tr></thead>
        <tbody>
          {shown.map((t) => (
            <tr key={t.tag}>
              <td><span className="name">{t.tag}</span>{t.cloud && <> <span className="chip cloud">cloud</span></>}</td>
              <td className="r num">{t.cloud ? "–" : fmtSize(t.size)}</td>
              <td className="r num">{fmtCtx(t.context)}</td>
              <td className="faint">{t.input.join(", ") || "–"}</td>
              <td className="faint">{t.quantization ?? "–"}</td>
              <td>{onPull && <button className="btn sm" onClick={() => onPull(t.name)}>Pull</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && <div className="hint">{hidden} tag{hidden === 1 ? "" : "s"} hidden by the filters.</div>}
    </div>
  );
}
