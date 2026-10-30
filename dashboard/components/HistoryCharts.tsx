"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api, fmtBytes, fmtMiB, instPath } from "@/lib/format";
import type { HistoryPoint, InstanceSnapshot } from "@/lib/types";

const RANGES = { "1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 } as const;
type Range = keyof typeof RANGES;
const RANGE_KEY = "paddock.historyRange";
const RESOLUTION: Record<number, string> = { 0: "every poll", 60: "1-minute averages", 900: "15-minute averages" };
// one colour per GPU (or per in/out line), from the theme so light and dark both work
const COLORS = ["var(--accent)", "var(--info)", "var(--ok)", "var(--warn)", "var(--bad)", "var(--accent2)", "var(--muted)", "var(--text)"];

interface Series {
  name: string;
  color: string;
  values: (number | null | undefined)[];
}

interface HistoryResponse {
  range: Range;
  resolution: number;
  points: HistoryPoint[];
}

export function HistoryCharts({ st }: { st: InstanceSnapshot }) {
  const [range, setRange] = useState<Range>("1h");
  const [data, setData] = useState<HistoryResponse | null>(null);

  // the chosen range is a per-browser convenience; storage can be unavailable (private mode)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RANGE_KEY);
      if (saved && saved in RANGES) setRange(saved as Range);
    } catch {}
  }, []);
  const pick = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {}
  };

  // 1h follows every poll; the averaged ranges only change once a minute
  const tick = range === "1h" ? st.updated : Math.floor((st.updated ?? 0) / 60);
  useEffect(() => {
    let live = true;
    api<HistoryResponse>(instPath(st.id, `/history?range=${range}`)).then((d) => live && setData(d)).catch(() => {});
    return () => {
      live = false;
    };
  }, [st.id, range, tick]);

  const pts = data?.range === range ? data.points : [];
  const times = pts.map((p) => p.t);
  const nGpu = pts.reduce((n, p) => Math.max(n, p.gpus?.length ?? 0), 0);
  const gpu = (k: "u" | "m" | "t" | "p"): Series[] =>
    Array.from({ length: nGpu }, (_, i) => ({ name: `GPU${i}`, color: COLORS[i % COLORS.length], values: pts.map((p) => p.gpus?.[i]?.[k]) }));
  const vramTotal = pts.reduce((m, p) => Math.max(m, ...(p.gpus ?? []).map((g) => g.mt ?? 0)), 0);
  // all GPUs together, in bytes: the most a model can occupy
  const vramAll = (st.stats?.nvidia.gpus ?? []).reduce((sum, g) => sum + (g.mem_total_mib ?? 0), 0) * 1048576;
  const powerLimit = st.stats?.nvidia.gpus.reduce((m, g) => Math.max(m, g.power_limit_w ?? 0), 0) || undefined;
  const hasHost = pts.some((p) => p.cpu != null);
  const hasNet = pts.some((p) => p.rx != null);
  const common = { times, range, resolution: data?.resolution ?? 0 };

  return (
    <div className="section">
      <div className="card-head">
        <h2>History</h2>
        <div className="history-ctl">
          {data?.range === range && <span className="faint">{RESOLUTION[data.resolution] ?? ""}</span>}
          <div className="seg" role="group" aria-label="Time range">
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <button key={r} className={r === range ? "on" : ""} aria-pressed={r === range} onClick={() => pick(r)}>{r}</button>
            ))}
          </div>
        </div>
      </div>
      {data?.range === range && pts.length < 2 ? (
        <div className="card empty">
          {range === "7d" || range === "30d"
            ? "No 15-minute averages yet. They appear once the dashboard has collected 15 minutes of history."
            : "Not enough history for this range yet."}
        </div>
      ) : (
        <div className="grid g2">
          {nGpu > 0 && (
            <>
              <LineChart title="GPU utilization" series={gpu("u")} yMax={100} fmt={(v) => `${v.toFixed(0)}%`} {...common} />
              <LineChart title="GPU memory" series={gpu("m")} yMax={vramTotal || undefined} fmt={fmtMiB} axisFmt={(v) => fmtBytes(v * 1048576, 0)} {...common} />
              <LineChart title="GPU temperature" series={gpu("t")} fmt={(v) => `${v.toFixed(0)}°C`} {...common} />
              <LineChart title="GPU power" series={gpu("p")} yMax={powerLimit} fmt={(v) => `${v.toFixed(0)} W`} {...common} />
            </>
          )}
          {hasHost && (
            <>
              <LineChart title="CPU" series={[{ name: "CPU", color: COLORS[0], values: pts.map((p) => p.cpu) }]} yMax={100} fmt={(v) => `${v.toFixed(0)}%`} {...common} />
              <LineChart title="RAM" series={[{ name: "RAM", color: COLORS[0], values: pts.map((p) => p.mem) }]} yMax={100} fmt={(v) => `${v.toFixed(0)}%`} {...common} />
            </>
          )}
          {hasNet && (
            <LineChart
              title="Network"
              series={[
                { name: "in", color: COLORS[0], values: pts.map((p) => p.rx) },
                { name: "out", color: COLORS[1], values: pts.map((p) => p.tx) },
              ]}
              fmt={(v) => `${fmtBytes(v)}/s`}
              axisFmt={(v) => `${fmtBytes(v, 0)}/s`}
              bytes
              {...common}
            />
          )}
          <LineChart title="Model VRAM · ollama ps" series={[{ name: "VRAM", color: COLORS[0], values: pts.map((p) => p.vram) }]} yMax={vramAll || undefined} bytes fmt={(v) => fmtBytes(v)} axisFmt={(v) => fmtBytes(v, 0)} {...common} />
        </div>
      )}
    </div>
  );
}

// ============================================================================ chart
const H = 160;
const PAD = { l: 52, r: 10, t: 8, b: 22 };

/** 1, 2, 2.5 or 5 times a power of ten, at least v: a round top for the y axis. */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= v)!;
}

/** niceMax in units of 1024, so byte axes end on 4 MB/s or 24 GB rather than 3.8 MB/s. */
function niceBytes(v: number): number {
  if (!(v > 0)) return 1024;
  const k = Math.max(0, Math.floor(Math.log(v) / Math.log(1024)));
  return niceMax(v / 1024 ** k) * 1024 ** k;
}

const TICK_STEPS = [300, 600, 900, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400];

/** Time ticks on round local times (whole hours, midnights), about one per 80px. */
function timeTicks(from: number, to: number, width: number): { t: number; label: string }[] {
  const want = Math.max(2, Math.floor(width / 80));
  const step = TICK_STEPS.find((s) => (to - from) / s <= want) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const shift = -new Date().getTimezoneOffset() * 60;
  const ticks = [];
  for (let t = Math.ceil((from + shift) / step) * step - shift; t <= to; t += step) {
    const d = new Date(t * 1000);
    const label = step >= 86400
      ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    ticks.push({ t, label });
  }
  return ticks;
}

function LineChart({ title, series, times, range, resolution, yMax, bytes, fmt, axisFmt }: {
  title: string;
  series: Series[];
  times: number[];
  range: Range;
  resolution: number;
  yMax?: number;
  /** values are bytes: round the axis in units of 1024 */
  bytes?: boolean;
  fmt: (v: number) => string;
  /** shorter labels for the y axis, which has little room */
  axisFmt?: (v: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // measure now: the observer's first callback can come a frame late and leave the chart blank
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const to = Date.now() / 1000;
  const from = to - RANGES[range];
  const plotW = Math.max(1, w - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const peak = Math.max(...all, 0) * 1.1;
  const top = yMax ?? (bytes ? niceBytes(peak) : niceMax(peak));
  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * plotW;
  const y = (v: number) => PAD.t + plotH - (Math.min(v, top) / top) * plotH;

  // A gap of more than 3 steps means the host wasn't polled: break the line there.
  const diffs = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const step = resolution || diffs[Math.floor(diffs.length / 2)] || 3;
  const segments = (s: Series) => {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    s.values.forEach((v, i) => {
      if (v == null || (i > 0 && times[i] - times[i - 1] > 3 * step)) {
        if (cur.length) out.push(cur);
        cur = [];
      }
      if (v != null) cur.push([x(times[i]), y(v)]);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const line = (segs: [number, number][][]) => segs.map((seg) => seg.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("")).join("");
  const area = (segs: [number, number][][]) =>
    segs.filter((seg) => seg.length > 1).map((seg) => `M${seg[0][0].toFixed(1)},${PAD.t + plotH}${line([seg]).replace(/^M/, "L")}L${seg[seg.length - 1][0].toFixed(1)},${PAD.t + plotH}Z`).join("");

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!times.length) return;
    const t = from + ((e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.l) / plotW) * (to - from);
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    setHover(lo > 0 && t - times[lo - 1] < times[lo] - t ? lo - 1 : lo);
  };

  const hx = hover != null ? x(times[hover]) : 0;
  const latest = (s: Series) => [...s.values].reverse().find((v): v is number => v != null);
  return (
    <div className="card chartcard">
      <div className="chart-head">
        <h3>{title}</h3>
        {series.length > 1 ? (
          <span className="legend">
            {series.map((s) => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}
          </span>
        ) : (
          latest(series[0]) != null && <b className="num">{fmt(latest(series[0])!)}</b>
        )}
      </div>
      <div className="chart" ref={ref}>
        {w > 0 && (
          <svg width={w} height={H} role="img" aria-label={`${title}, last ${range}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line className="grid" x1={PAD.l} x2={PAD.l + plotW} y1={y(top * f)} y2={y(top * f)} />
                <text x={PAD.l - 6} y={y(top * f) + 4} textAnchor="end">{(axisFmt ?? fmt)(top * f)}</text>
              </g>
            ))}
            {timeTicks(from, to, plotW).map(({ t, label }) => (
              <text key={t} x={x(t)} y={H - 6} textAnchor="middle">{label}</text>
            ))}
            {series.length === 1 && <path className="area" d={area(segments(series[0]))} style={{ fill: series[0].color }} />}
            {series.map((s) => <path key={s.name} className="line" d={line(segments(s))} style={{ stroke: s.color }} />)}
            {hover != null && (
              <g>
                <line className="cursor" x1={hx} x2={hx} y1={PAD.t} y2={PAD.t + plotH} />
                {series.map((s) => s.values[hover] != null && <circle key={s.name} cx={hx} cy={y(s.values[hover]!)} r={3} style={{ fill: s.color }} />)}
              </g>
            )}
          </svg>
        )}
        {hover != null && (
          <div className="tip" style={hx > w / 2 ? { right: w - hx + 10 } : { left: hx + 10 }}>
            <div className="faint">{new Date(times[hover] * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
            {series.map((s) => (
              <div key={s.name}>
                {series.length > 1 && <i style={{ background: s.color }} />}
                {series.length > 1 && `${s.name} `}
                <b className="num">{s.values[hover] != null ? fmt(s.values[hover]!) : "–"}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
