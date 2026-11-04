"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { level } from "@/lib/format";
import { cloudNote, isOffloaded, splitHint, splitText } from "@/lib/split";
import type { InstanceSnapshot, LoadedModel } from "@/lib/types";

export function Meter({ label, value, p, cls }: { label: string; value: string; p: number; cls?: string }) {
  return (
    <div className="meter">
      <div className="lbl">
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <div className="bar">
        <i className={cls ?? level(p)} style={{ width: `${p.toFixed(1)}%` }} />
      </div>
    </div>
  );
}

export function Spark({ values, max }: { values: (number | null | undefined)[]; max?: number | null }) {
  const real = values.filter((v): v is number => v != null);
  if (real.length < 2) return <svg className="spark" viewBox="0 0 100 40" />;
  const hi = max || Math.max(...real, 1);
  const n = values.length;
  let d = "";
  let first: number | null = null;
  let last = 0;
  values.forEach((v, i) => {
    if (v == null) return;
    const x = (i / (n - 1)) * 100;
    const y = 38 - (Math.min(v, hi) / hi) * 36;
    d += `${d ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    if (first == null) first = x;
    last = x;
  });
  return (
    <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none">
      <path className="a" d={`${d}L${last},40L${first},40Z`} />
      <path className="l" d={d} />
    </svg>
  );
}

export function SparkCell({ label, value, values, max }: { label: string; value: string; values: (number | null | undefined)[]; max?: number | null }) {
  return (
    <div className="sparkcell">
      <div className="lbl">
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <Spark values={values} max={max} />
    </div>
  );
}

export function Stat({ k, v, unit, small }: { k: string; v: ReactNode; unit?: string; small?: boolean }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" style={small ? { fontSize: 15 } : undefined}>
        {v}
        {unit && <small> {unit}</small>}
      </div>
    </div>
  );
}

/**
 * A loaded model as a chip with its GPU/CPU split: "qwen3:32b · 62% GPU". The text carries the state, the
 * colour only repeats it; screen readers also get the reason, which sighted users see as a tooltip.
 */
export function SplitChip({ m, label = m.name }: { m: LoadedModel; label?: string }) {
  const s = m.split;
  const cls = s.state === "cloud" ? "cloud" : isOffloaded(s) ? "warn" : s.state === "unknown" ? "" : "acc";
  const tip = s.state === "cloud" ? cloudNote() : splitHint(s);
  const spoken = s.state === "cloud" ? cloudNote() : isOffloaded(s) ? "not fully on the GPU" : s.state === "unknown" ? tip : null;
  return (
    <span className={`chip ${cls}`} title={tip ?? undefined}>
      {label ? `${label} · ` : ""}{splitText(s)}
      {spoken && <span className="sr-only">: {spoken}</span>}
    </span>
  );
}

/** Why a model isn't fully on the GPU, folded away so a table row stays one line until asked. */
export function SplitHint({ m }: { m: LoadedModel }) {
  if (!isOffloaded(m.split)) return null;
  return (
    <details className="split-hint">
      <summary>Not fully on the GPU: why?</summary>
      {splitHint(m.split)}
    </details>
  );
}

/** The badge for an Ollama cloud model, wherever models are listed. */
export function CloudBadge({ remoteHost }: { remoteHost?: string | null }) {
  const note = cloudNote(remoteHost);
  return (
    <span className="chip cloud" title={note}>
      cloud<span className="sr-only">: {note}</span>
    </span>
  );
}

export function statusOf(st: InstanceSnapshot): ["" | "ok" | "warn" | "bad", string] {
  if (!st.updated) return ["", "connecting"];
  if (!st.ollama_ok) return ["bad", "ollama down"];
  if (st.has_agent && !st.agent_ok) return ["warn", "agent down"];
  return ["ok", "online"];
}

export function Drawer({ open, onClose, className, children }: { open: boolean; onClose: () => void; className?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className={`drawer ${className ?? ""}`}>{children}</aside>
    </>
  );
}

/** A button that opens a small panel under it, for detail that shouldn't take room on the page. Escape or a click outside closes it. */
export function Popover({ label, className, title, children }: { label: ReactNode; className?: string; title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="popover-anchor" ref={ref}>
      <button type="button" className={className} title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <div className="popover" role="dialog">{children}</div>}
    </span>
  );
}
