export function fmtBytes(b: number | null | undefined, d = 1): string {
  if (b == null || Number.isNaN(b)) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i === 0 ? 0 : d)} ${u[i]}`;
}

export const fmtMiB = (m: number | null | undefined) => (m == null ? "–" : fmtBytes(m * 1048576));

export function fmtDur(s: number | null | undefined): string {
  if (s == null) return "–";
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function untilText(iso?: string): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "–";
  const diff = (t - Date.now()) / 1000;
  if (diff > 3600 * 24 * 365) return "forever";
  if (diff < 0) return "expiring";
  return "in " + fmtDur(diff);
}

export function ago(iso?: string): string {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "–";
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const pct = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? Math.min(100, (a / b) * 100) : 0);
export const level = (p: number, warn = 75, bad = 90) => (p >= bad ? "bad" : p >= warn ? "warn" : "");
export const fmtNum = (n: number | null | undefined) => (n == null ? "–" : Number(n).toLocaleString());

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? "GET", headers: {}, cache: "no-store" };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  let data: any = null;
  try {
    data = await r.json();
  } catch {
    /* empty body */
  }
  if (!r.ok) throw new Error(data?.detail ?? `HTTP ${r.status}`);
  return data as T;
}

export const instPath = (id: string, rest = "") => `/api/instances/${encodeURIComponent(id)}${rest}`;
