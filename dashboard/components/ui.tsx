"use client";

import { useEffect, type ReactNode } from "react";
import { level } from "@/lib/format";
import type { InstanceSnapshot } from "@/lib/types";

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
