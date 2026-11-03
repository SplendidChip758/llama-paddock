"use client";

import { useEffect, useState } from "react";
import { api, fmtDur, instPath } from "@/lib/format";
import type { Availability as Track, AvailabilitySegment, HostAvailability, InstanceSnapshot } from "@/lib/types";
import { whenText } from "./AlertBits";

const RANGES = [["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"]] as const;
type Range = (typeof RANGES)[number][0];
/** The 30-day timeline is worked out from every event in the range, so it isn't refetched on every poll. */
const REFRESH_MS = 60_000;
const OUTAGES_SHOWN = 8;

const STATE_TEXT: Record<AvailabilitySegment["state"], string> = {
  up: "up", down: "down", unknown: "not seen yet", unobserved: "not watched",
};

const pctText = (p: number | null) => (p == null ? "–" : `${p >= 99.95 && p < 100 ? "99.9" : p.toFixed(p === 100 ? 0 : 2)}%`);

/** Ollama's and the agent's uptime on a host's Monitor tab: timelines, the share of time up, and recent outages. */
export function Availability({ st }: { st: InstanceSnapshot }) {
  const [range, setRange] = useState<Range>("7d");
  const [data, setData] = useState<HostAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let live = true;
    api<HostAvailability>(instPath(st.id, `/uptime?range=${range}`))
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [st.id, range, tick]);

  const outages = data
    ? [
        ...data.ollama.outages.map((o) => ({ ...o, what: "Ollama" })),
        ...(data.agent?.outages ?? []).map((o) => ({ ...o, what: "Agent" })),
      ].sort((a, b) => b.start - a.start)
    : [];
  const rangeText = RANGES.find(([r]) => r === range)![1];

  return (
    <div className="section">
      <div className="card-head">
        <h2>Availability</h2>
        <div className="seg" role="group" aria-label="Availability range">
          {RANGES.map(([r]) => (
            <button key={r} className={r === range ? "on" : ""} aria-pressed={r === range} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>
      <div className="card">
        {error ? (
          <div className="notice bad">{error}</div>
        ) : !data ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <TimelineRow label="Ollama" track={data.ollama} from={data.from} to={data.to} />
            {data.agent && <TimelineRow label="Agent" track={data.agent} from={data.from} to={data.to} />}
            <div className="tl-axis faint">
              <span>{whenText(data.from)}</span>
              <span>now</span>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              The dashboard watched this host for {data.coverage < 0.01 ? "less than 1%" : `${Math.round(data.coverage * 100)}%`} of the last {rangeText}. Time it wasn&apos;t
              running or polling is hatched and doesn&apos;t count toward the percentages.
            </div>
            {outages.length > 0 && (
              <div className="tablewrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr><th>Outage</th><th>Started</th><th>Lasted</th><th>Why</th></tr>
                  </thead>
                  <tbody>
                    {outages.slice(0, OUTAGES_SHOWN).map((o) => (
                      <tr key={`${o.what}/${o.start}`}>
                        <td>{o.what} down</td>
                        <td className="mono">{whenText(o.start)}</td>
                        <td className="mono">{o.ongoing ? <span className="chip bad">ongoing</span> : fmtDur(o.end - o.start)}</td>
                        <td className="hint" style={{ marginTop: 0, wordBreak: "break-word" }}>{o.error ?? "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!outages.length && <div className="hint" style={{ marginTop: 8 }}>No outages seen in the last {rangeText}.</div>}
          </>
        )}
      </div>
    </div>
  );
}

function TimelineRow({ label, track, from, to }: { label: string; track: Track; from: number; to: number }) {
  const span = to - from;
  return (
    <div className="tl-row">
      <div className="tl-label">
        <span>{label}</span>
        <b>{pctText(track.up_pct)}</b>
      </div>
      <div className="tl" role="img" aria-label={`${label}: up ${pctText(track.up_pct)} of the watched time, ${track.outages.length} outage${track.outages.length === 1 ? "" : "s"}`}>
        {track.segments.map((x) => (
          <i key={x.start} className={`tl-${x.state}`}
            style={{ left: `${((x.start - from) / span) * 100}%`, width: `${((x.end - x.start) / span) * 100}%` }}
            title={`${STATE_TEXT[x.state]}: ${whenText(x.start)} – ${whenText(x.end)} (${fmtDur(x.end - x.start)})${x.error ? `\n${x.error}` : ""}`} />
        ))}
      </div>
    </div>
  );
}
