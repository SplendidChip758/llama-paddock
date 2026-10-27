"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, instPath } from "@/lib/format";
import type { InstanceSnapshot } from "@/lib/types";

export function LogsTab({ st }: { st: InstanceSnapshot }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(200);
  const [auto, setAuto] = useState(false);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const fetchLogs = useCallback(async () => {
    try {
      const r = await api<{ lines: string[] }>(instPath(st.id, `/logs?lines=${count}`));
      const el = box.current;
      stick.current = !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
      setLines(r.lines);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [st.id, count]);

  useEffect(() => {
    if (st.has_agent) fetchLogs();
  }, [fetchLogs, st.has_agent]);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(fetchLogs, 4000);
    return () => clearInterval(t);
  }, [auto, fetchLogs]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  if (!st.has_agent) return <div className="notice">Logs need the llama-paddock agent on this host.</div>;
  const source = st.stats?.platform === "windows" ? "lines of server.log" : "lines of journalctl -u ollama";

  return (
    <>
      <div className="row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <div className="row">
          <select style={{ width: "auto" }} value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[200, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="sub">{source}</span>
        </div>
        <div className="row">
          <label className="sub row" style={{ gap: 6 }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> auto-refresh
          </label>
          <button className="btn" onClick={fetchLogs}>Refresh</button>
        </div>
      </div>
      {error && <div className="notice bad">{error}</div>}
      <pre className="logs" ref={box}>
        {lines === null
          ? "Loading…"
          : lines.map((l, i) => {
              const cls = /level=ERROR|error|panic|fatal/i.test(l) ? "err" : /level=WARN|warn/i.test(l) ? "wrn" : undefined;
              return (
                <span key={i} className={cls}>
                  {l}
                  {"\n"}
                </span>
              );
            })}
      </pre>
    </>
  );
}
