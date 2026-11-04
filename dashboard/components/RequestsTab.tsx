"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, instPath } from "@/lib/format";
import type { InstanceSnapshot, RequestLogPage, RequestSummary } from "@/lib/types";
import { whenText } from "./AlertBits";
import { usePaddock } from "./PaddockProvider";
import { Stat } from "./ui";

const RANGES = ["1h", "24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];
/** The dashboard reads request logs every 10 polls; refetching more often shows nothing new. */
const REFRESH_MS = 30_000;
/** Rows the clients, endpoints and models tables show until "Show all": the page stays about a screen long. */
const TOP = 10;
/** The most the API lists per table. */
const API_TOP = 50;
const PAGE = 25;
type Table = "clients" | "endpoints" | "models";

function fmtMs(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)} µs`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const errPct = (count: number, errors: number) => (count ? `${((errors / count) * 100).toFixed(errors && errors < count / 100 ? 1 : 0)}%` : "–");

/** Requests to Ollama on this host, read from its log by the agent: who called, what, how fast, and what failed. */
export function RequestsTab({ st }: { st: InstanceSnapshot }) {
  const { toast } = usePaddock();
  const [range, setRange] = useState<Range>("24h");
  const [data, setData] = useState<RequestSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [naming, setNaming] = useState<{ client: string; name: string } | null>(null);
  const [all, setAll] = useState<Partial<Record<Table, boolean>>>({});

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  const load = useCallback(async () => {
    try {
      setData(await api<RequestSummary>(instPath(st.id, `/requests?range=${range}`)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [st.id, range]);
  useEffect(() => {
    void load();
  }, [load, tick]);

  const saveName = async () => {
    if (!naming) return;
    try {
      const { names } = await api<{ names: Record<string, string> }>("/api/request-clients");
      await api("/api/request-clients", { method: "PUT", body: { names: { ...names, [naming.client]: naming.name } } });
      toast(naming.name.trim() ? `Named ${naming.client} “${naming.name.trim()}”` : `Removed the name of ${naming.client}`, "ok");
      setNaming(null);
      await load();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };

  if (!st.has_agent) {
    return <div className="notice">The request log is read from Ollama&apos;s log by the agent. Install the agent on this host to see it.</div>;
  }
  const label = (client: string, name: string | null) => (name ? <><b>{name}</b> <span className="faint mono">{client}</span></> : <span className="mono">{client}</span>);
  const nameOf = (client: string) => data?.clients.find((x) => x.client === client)?.name ?? null;
  const top = <T,>(t: Table, rows: T[]) => (all[t] ? rows : rows.slice(0, TOP));
  const more = (t: Table, n: number) => n > TOP && (
    <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setAll({ ...all, [t]: !all[t] })}>
      {all[t] ? `Show the top ${TOP}` : n >= API_TOP ? `Show the ${API_TOP} busiest` : `Show all ${n}`}
    </button>
  );

  return (
    <>
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Requests <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>· Ollama&apos;s log</span></h2>
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => <button key={r} className={r === range ? "on" : ""} aria-pressed={r === range} onClick={() => setRange(r)}>{r}</button>)}
        </div>
      </div>
      {error && <div className="notice bad">{error}</div>}
      {data?.sync.unsupported && (
        <div className="notice warn">This host&apos;s agent is older than 0.8.0 and doesn&apos;t read Ollama&apos;s request log. Update the agent to collect requests.</div>
      )}
      {data?.sync.error && <div className="notice warn">Reading the request log failed: {data.sync.error}</div>}
      {!data ? (
        !error && <div className="empty">Loading…</div>
      ) : (
        <>
          <div className="stats" style={{ marginBottom: 14 }}>
            <Stat k="Requests" v={fmtNum(data.total.count)} />
            <Stat k="Errors" v={errPct(data.total.count, data.total.errors)} unit={data.total.errors ? `${fmtNum(data.total.errors)}` : undefined} />
            <Stat k="Average" v={data.total.count ? fmtMs(data.total.avg_ms) : "–"} />
            <Stat k="Slowest" v={data.total.count ? fmtMs(data.total.max_ms) : "–"} />
            <Stat k="Clients" v={data.clients.length} />
          </div>

          <div className="card">
            <Bars data={data} />
          </div>

          {data.total.count === 0 ? (
            <div className="empty" style={{ marginTop: 14 }}>
              No requests in the last {range}{data.sync.last_ok ? "" : " yet: the log is read every few polls"}.
            </div>
          ) : (
            <>
              <div className="section">
                <h2>Clients</h2>
                <div className="card tablewrap">
                  <table>
                    <thead><tr><th>Client</th><th className="num">Requests</th><th className="num">Errors</th><th className="num">Average</th><th className="num">Slowest</th><th>Last</th><th /></tr></thead>
                    <tbody>
                      {top("clients", data.clients).map((x) => (
                        <tr key={x.client}>
                          <td>
                            {naming?.client === x.client ? (
                              <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
                                <input autoFocus value={naming.name} maxLength={60} placeholder="open-webui" aria-label={`Name for ${x.client}`}
                                  onChange={(e) => setNaming({ ...naming, name: e.target.value })} style={{ width: 160 }} />
                                <button className="btn sm" type="submit">Save</button>
                                <button className="btn sm" type="button" onClick={() => setNaming(null)}>Cancel</button>
                              </form>
                            ) : label(x.client, x.name)}
                          </td>
                          <td className="num">{fmtNum(x.count)}</td>
                          <td className={`num ${x.errors ? "bad-text" : ""}`}>{x.errors ? `${fmtNum(x.errors)} · ${errPct(x.count, x.errors)}` : "–"}</td>
                          <td className="num">{fmtMs(x.avg_ms)}</td>
                          <td className="num">{fmtMs(x.max_ms)}</td>
                          <td className="mono">{whenText(x.last)}</td>
                          <td><div className="actions">{naming?.client !== x.client && (
                            <button className="btn sm" onClick={() => setNaming({ client: x.client, name: x.name ?? "" })}>{x.name ? "Rename" : "Name"}</button>
                          )}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {more("clients", data.clients.length)}
              </div>

              <div className="grid g2 section">
                <div>
                  <h2>Endpoints</h2>
                  <div className="card tablewrap">
                    <table>
                      <thead><tr><th>Endpoint</th><th className="num">Requests</th><th className="num">Errors</th><th className="num">Average</th></tr></thead>
                      <tbody>
                        {top("endpoints", data.endpoints).map((x) => (
                          <tr key={`${x.method} ${x.path}`}>
                            <td className="mono">{x.method} {x.path}</td>
                            <td className="num">{fmtNum(x.count)}</td>
                            <td className={`num ${x.errors ? "bad-text" : ""}`}>{x.errors ? errPct(x.count, x.errors) : "–"}</td>
                            <td className="num">{fmtMs(x.avg_ms)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {more("endpoints", data.endpoints.length)}
                </div>
                <div>
                  <h2>Models</h2>
                  <div className="card tablewrap">
                    {data.models.length ? (
                      <table>
                        <thead><tr><th>Model</th><th className="num">Requests</th><th className="num">Average</th></tr></thead>
                        <tbody>
                          {top("models", data.models).map((x) => (
                            <tr key={x.model}><td className="mono">{x.model}</td><td className="num">{fmtNum(x.count)}</td><td className="num">{fmtMs(x.avg_ms)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <div className="empty">No requests matched to a model yet.</div>}
                  </div>
                  {more("models", data.models.length)}
                  <div className="hint" style={{ marginTop: 8 }}>
                    Ollama&apos;s log doesn&apos;t name the model. A request is counted here when exactly one model was loaded at the time.
                  </div>
                </div>
              </div>

              <RequestLog key={range} st={st} range={range} to={data.to} nameOf={nameOf} />
            </>
          )}
          <div className="hint" style={{ marginTop: 12 }}>
            From each line Ollama logs: time, status, duration, client address, method and endpoint. No prompts or answers are
            collected, since Ollama doesn&apos;t log them. Monitoring calls (<code>/api/ps</code>, <code>/api/version</code>) aren&apos;t kept.
            {data.sync.skipped > 0 && ` ${fmtNum(data.sync.skipped)} line${data.sync.skipped === 1 ? "" : "s"} in a format this dashboard doesn't know were skipped.`}
          </div>
        </>
      )}
    </>
  );
}

/** Requests per bucket over the range, the errors in red. */
function Bars({ data }: { data: RequestSummary }) {
  const n = Math.ceil((data.to - data.from) / data.bucket_s);
  const first = Math.floor(data.from / data.bucket_s) * data.bucket_s;
  const byT = new Map(data.buckets.map((b) => [b.t, b]));
  const slots = Array.from({ length: n + 1 }, (_, i) => byT.get(first + i * data.bucket_s) ?? { t: first + i * data.bucket_s, count: 0, errors: 0 });
  const max = Math.max(1, ...slots.map((b) => b.count));
  return (
    <div>
      <div className="reqbars" role="img" aria-label={`Requests over the last ${data.range}: ${data.total.count}, ${data.total.errors} errors`}>
        {slots.map((b) => (
          <div key={b.t} className="reqbar" title={`${whenText(b.t)}: ${b.count} request${b.count === 1 ? "" : "s"}${b.errors ? `, ${b.errors} errors` : ""}`}>
            <i style={{ height: `${(b.count / max) * 100}%` }}>
              {b.errors > 0 && <em style={{ height: `${(b.errors / b.count) * 100}%` }} />}
            </i>
          </div>
        ))}
      </div>
      <div className="tl-axis faint" style={{ marginLeft: 0 }}>
        <span>{whenText(data.from)}</span>
        <span>{max} max</span>
        <span>now</span>
      </div>
    </div>
  );
}

/** The latest or slowest requests in the range, a page at a time; `to` pins the range's end, as the summary saw it. */
function RequestLog({ st, range, to, nameOf }: { st: InstanceSnapshot; range: Range; to: number; nameOf: (client: string) => string | null }) {
  const [sort, setSort] = useState<RequestLogPage["sort"]>("latest");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<RequestLogPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<RequestLogPage>(instPath(st.id, `/requests/log?range=${range}&sort=${sort}&offset=${offset}&limit=${PAGE}&to=${to}`))
      .then((p) => {
        if (!live) return;
        setPage(p);
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [st.id, range, sort, offset, to]);

  const rows = page?.requests ?? [];
  const total = page?.total ?? 0;
  return (
    <div className="section">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Log</h2>
        <div className="seg" role="group" aria-label="Order">
          {(["latest", "slowest"] as const).map((s) => (
            <button key={s} className={s === sort ? "on" : ""} aria-pressed={s === sort} onClick={() => { setSort(s); setOffset(0); }}>
              {s === "latest" ? "Latest" : "Slowest"}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="notice bad">{error}</div>}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Time</th><th>Client</th><th>Endpoint</th><th>Model</th><th className="num">Status</th><th className="num">Duration</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.t}/${r.client}/${r.method}/${r.path}/${r.duration_ms}`}>
                <td className="mono">{whenText(r.t)}</td>
                <td>{nameOf(r.client) ?? <span className="mono">{r.client}</span>}</td>
                <td className="mono">{r.method} {r.path}</td>
                <td className="mono">{r.model ?? <span className="faint">–</span>}</td>
                <td className={`num ${r.status >= 400 ? "bad-text" : ""}`}>{r.status}</td>
                <td className="num">{fmtMs(r.duration_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > PAGE && (
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <span className="hint">{fmtNum(offset + 1)}–{fmtNum(offset + rows.length)} of {fmtNum(total)}</span>
          <button className="btn sm" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹</button>
          <button className="btn sm" aria-label="Next page" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>›</button>
        </div>
      )}
    </div>
  );
}
