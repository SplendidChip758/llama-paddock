/**
 * What the dashboard failed to save to paddock.db. A failed write is logged and the dashboard
 * carries on, so the history it couldn't keep would otherwise be lost without a word. Each area
 * clears on its next successful write. Shown on every page, by /api/storage, /api/healthz
 * (storage_ok) and /metrics.
 */
export type StorageArea = "history" | "events" | "alerts" | "requests" | "audit" | "jobs" | "benchmarks" | "model_sizes";

/** What the user loses while the area can't be saved. */
const AREAS: Record<StorageArea, { label: string; loss: string }> = {
  history: { label: "metric history", loss: "charts have a gap for this time" },
  events: { label: "host events", loss: "availability and model loads for this time stay unknown" },
  alerts: { label: "alert history", loss: "a restart may lose track of firing alerts" },
  requests: { label: "request log", loss: "requests in this time aren't listed" },
  audit: { label: "audit log", loss: "changes made now aren't recorded" },
  jobs: { label: "jobs", loss: "a restart may lose running pulls and creates" },
  benchmarks: { label: "benchmarks", loss: "benchmark results may be lost" },
  model_sizes: { label: "model sizes", loss: "fit estimates don't learn from what's loaded" },
};

export interface StorageFailure {
  area: StorageArea;
  label: string;
  loss: string;
  error: string;
  /** when this area first failed, and most recently (unix seconds) */
  since: number;
  last: number;
  count: number;
}

const g = globalThis as unknown as { __paddockStorage?: Map<StorageArea, StorageFailure> };
const failures = () => (g.__paddockStorage ??= new Map());

/** A write for the area failed: log it, and keep it until a write succeeds. */
export function saveFailed(area: StorageArea, e: unknown, what = `saving the ${AREAS[area].label}`) {
  const error = e instanceof Error ? e.message : String(e);
  const now = Date.now() / 1000;
  const f = failures().get(area);
  // the first failure and every new error in full; repeats would flood the log every poll
  if (!f || f.error !== error) console.error(`[llama-paddock] ${what} failed:`, e);
  failures().set(area, f
    ? { ...f, error, last: now, count: f.count + 1 }
    : { area, ...AREAS[area], error, since: now, last: now, count: 1 });
}

/** A write for the area succeeded. */
export function saved(area: StorageArea) {
  if (failures().delete(area)) console.log(`[llama-paddock] saving the ${AREAS[area].label} works again`);
}

/** Areas whose last write failed, oldest failure first. */
export function storageFailures(): StorageFailure[] {
  return [...failures().values()].sort((a, b) => a.since - b.since);
}

export const STORAGE_AREAS = Object.keys(AREAS) as StorageArea[];
