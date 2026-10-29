// SQLite in the data directory (paddock.db): metric history and job state, so both survive a restart.
// Uses node:sqlite (built into Node >= 22.13), so there is no native module to build per platform.
import "server-only";
import fs from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { dataDir, dataFile } from "./store";
import type { HistoryPoint, JobInfo } from "./types";

const DB_FILE = "paddock.db";

// ============================================================================ schema
// Each entry upgrades the schema by one version (PRAGMA user_version). Never edit a shipped
// entry: append a new one, so existing databases migrate automatically on start.
const MIGRATIONS: string[] = [
  `
  -- res: bucket size in seconds, 0 = raw polls. t: unix seconds (bucket start for rollups).
  CREATE TABLE samples (
    instance TEXT NOT NULL, res INTEGER NOT NULL, t INTEGER NOT NULL,
    cpu REAL, mem REAL, vram REAL NOT NULL, loaded REAL NOT NULL,
    PRIMARY KEY (instance, res, t)
  ) WITHOUT ROWID;
  CREATE INDEX samples_res_t ON samples (res, t);

  CREATE TABLE gpu_samples (
    instance TEXT NOT NULL, res INTEGER NOT NULL, t INTEGER NOT NULL, gpu INTEGER NOT NULL,
    util REAL, mem REAL, mem_total REAL, temp REAL, power REAL,
    PRIMARY KEY (instance, res, t, gpu)
  ) WITHOUT ROWID;
  CREATE INDEX gpu_samples_res_t ON gpu_samples (res, t);

  -- rollups: every bucket of size res that starts before done has been written.
  CREATE TABLE rollups (res INTEGER PRIMARY KEY, done INTEGER NOT NULL);

  -- jobs: info is the JobInfo JSON; path + body are the Ollama request, so a pull can be resumed.
  CREATE TABLE jobs (id TEXT PRIMARY KEY, info TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL);
  `,
  `
  -- network throughput in bytes/s, for the long-range charts; null before this version and without an agent
  ALTER TABLE samples ADD COLUMN rx REAL;
  ALTER TABLE samples ADD COLUMN tx REAL;
  `,
];

function migrate(db: DatabaseSync) {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version > MIGRATIONS.length) {
    throw new Error(`${DB_FILE} is from a newer llama-paddock (schema ${version}, this version knows ${MIGRATIONS.length}); upgrade the dashboard`);
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Load node:sqlite without its one-off ExperimentalWarning, and with a clear error on an old Node. */
function sqlite(): typeof import("node:sqlite") {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite is an experimental feature")) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = process.getBuiltinModule?.("node:sqlite");
    if (!mod) throw new Error(`llama-paddock needs Node.js 22.13 or newer (this is ${process.versions.node})`);
    return mod;
  } finally {
    process.emitWarning = emit;
  }
}

function open(): DatabaseSync {
  const { DatabaseSync } = sqlite();
  let db: DatabaseSync;
  try {
    fs.mkdirSync(/*turbopackIgnore: true*/ dataDir(), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(dataFile(DB_FILE));
    fs.chmodSync(/*turbopackIgnore: true*/ dataFile(DB_FILE), 0o600);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  } catch (e) {
    // Keep monitoring working when the data directory isn't writable; history just won't survive a restart.
    console.warn(`[llama-paddock] can't open ${dataFile(DB_FILE)} (${e instanceof Error ? e.message : e}); history is kept in memory only`);
    db = new DatabaseSync(":memory:");
  }
  migrate(db);
  return db;
}

// One connection per server process, shared by every route bundle.
const g = globalThis as unknown as { __paddockDb?: DatabaseSync };

function db(): DatabaseSync {
  return (g.__paddockDb ??= open());
}

function tx<T>(fn: (db: DatabaseSync) => T): T {
  const d = db();
  d.exec("BEGIN");
  try {
    const r = fn(d);
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

// ============================================================================ metric history
const HOUR = 3600;
const DAY = 24 * HOUR;

/** Raw polls are rolled up into 1-minute and then 15-minute averages. `keep` is capped by the retention setting. */
const TIERS = [
  { res: 0, keep: DAY },
  { res: 60, keep: 7 * DAY },
  { res: 900, keep: Infinity },
] as const;

/** Chart ranges for /history?range=…, each read from the finest tier that keeps the whole range. */
export const RANGES = {
  "1h": { seconds: HOUR, res: 0 },
  "6h": { seconds: 6 * HOUR, res: 60 },
  "24h": { seconds: DAY, res: 60 },
  "7d": { seconds: 7 * DAY, res: 900 },
  "30d": { seconds: 30 * DAY, res: 900 },
} as const;
export type HistoryRange = keyof typeof RANGES;

/** Store one raw poll per instance, in a single transaction. */
export function recordSamples(rows: [instance: string, point: HistoryPoint][]) {
  if (!rows.length) return;
  tx((d) => {
    const host = d.prepare("INSERT OR REPLACE INTO samples (instance, res, t, cpu, mem, vram, loaded, rx, tx) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)");
    const gpu = d.prepare("INSERT OR REPLACE INTO gpu_samples (instance, res, t, gpu, util, mem, mem_total, temp, power) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)");
    for (const [instance, p] of rows) {
      const t = Math.round(p.t);
      host.run(instance, t, p.cpu ?? null, p.mem ?? null, p.vram, p.loaded, p.rx ?? null, p.tx ?? null);
      p.gpus?.forEach((x, i) => gpu.run(instance, t, i, x.u, x.m, x.mt, x.t, x.p));
    }
  });
}

interface SampleRow { t: number; cpu: number | null; mem: number | null; vram: number; loaded: number; rx: number | null; tx: number | null }
interface GpuRow { t: number; gpu: number; util: number | null; mem: number | null; mem_total: number | null; temp: number | null; power: number | null }

/** Join host rows with their GPU rows into the HistoryPoint shape the UI already uses. */
function toPoints(rows: SampleRow[], gpuRows: GpuRow[]): HistoryPoint[] {
  const gpus = new Map<number, NonNullable<HistoryPoint["gpus"]>>();
  for (const r of gpuRows) {
    let list = gpus.get(r.t);
    if (!list) gpus.set(r.t, (list = []));
    list[r.gpu] = { u: r.util, m: r.mem, mt: r.mem_total, t: r.temp, p: r.power };
  }
  return rows.map((r) => {
    const p: HistoryPoint = { t: r.t, vram: Math.round(r.vram), loaded: r.loaded };
    if (r.cpu !== null) p.cpu = r.cpu;
    if (r.mem !== null) p.mem = r.mem;
    if (r.rx !== null) p.rx = r.rx;
    if (r.tx !== null) p.tx = r.tx;
    const g = gpus.get(r.t);
    if (g) p.gpus = Array.from(g, (x) => x ?? { u: null, m: null, mt: null, t: null, p: null });
    return p;
  });
}

function readSince(instance: string, res: number, since: number): HistoryPoint[] {
  const d = db();
  const rows = d.prepare("SELECT t, cpu, mem, vram, loaded, rx, tx FROM samples WHERE instance = ? AND res = ? AND t >= ? ORDER BY t")
    .all(instance, res, since) as unknown as SampleRow[];
  if (!rows.length) return [];
  const gpuRows = d.prepare("SELECT t, gpu, util, mem, mem_total, temp, power FROM gpu_samples WHERE instance = ? AND res = ? AND t >= ?")
    .all(instance, res, rows[0].t) as unknown as GpuRow[];
  return toPoints(rows, gpuRows);
}

/** The latest `limit` raw polls (the sparklines). */
export function recentHistory(instance: string, limit: number): HistoryPoint[] {
  const first = db().prepare("SELECT t FROM samples WHERE instance = ? AND res = 0 ORDER BY t DESC LIMIT 1 OFFSET ?")
    .get(instance, Math.max(0, limit - 1)) as { t: number } | undefined;
  return readSince(instance, 0, first?.t ?? 0);
}

export function rangeHistory(instance: string, range: HistoryRange, now = Date.now() / 1000) {
  const { seconds, res } = RANGES[range];
  return { range, resolution: res, points: readSince(instance, res, Math.floor(now - seconds)) };
}

export function deleteHistory(instance: string) {
  tx((d) => {
    d.prepare("DELETE FROM samples WHERE instance = ?").run(instance);
    d.prepare("DELETE FROM gpu_samples WHERE instance = ?").run(instance);
  });
}

/** Average every complete `dst` bucket of the `src` tier that hasn't been rolled up yet. */
function rollup(d: DatabaseSync, src: number, dst: number, now: number) {
  const done = (d.prepare("SELECT done FROM rollups WHERE res = ?").get(dst) as { done: number } | undefined)?.done;
  let to = Math.floor(now / dst) * dst;
  // A coarser tier may only use source buckets that are themselves complete.
  if (src > 0) to = Math.min(to, (d.prepare("SELECT done FROM rollups WHERE res = ?").get(src) as { done: number } | undefined)?.done ?? 0);
  const oldest = (d.prepare("SELECT min(t) AS t FROM samples WHERE res = ?").get(src) as { t: number | null }).t;
  if (oldest === null) return;
  const from = done ?? Math.floor(oldest / dst) * dst;
  if (from >= to) return;
  // dst is inlined: node:sqlite binds JS numbers as REAL, and t / 60.0 wouldn't truncate to a bucket.
  const args: SQLInputValue[] = [src, from, to];
  d.prepare(`
    INSERT OR REPLACE INTO samples (instance, res, t, cpu, mem, vram, loaded, rx, tx)
    SELECT instance, ${dst}, (t / ${dst}) * ${dst} AS b, avg(cpu), avg(mem), avg(vram), avg(loaded), avg(rx), avg(tx)
    FROM samples WHERE res = ? AND t >= ? AND t < ? GROUP BY instance, b
  `).run(...args);
  d.prepare(`
    INSERT OR REPLACE INTO gpu_samples (instance, res, t, gpu, util, mem, mem_total, temp, power)
    SELECT instance, ${dst}, (t / ${dst}) * ${dst} AS b, gpu, avg(util), avg(mem), max(mem_total), avg(temp), avg(power)
    FROM gpu_samples WHERE res = ? AND t >= ? AND t < ? GROUP BY instance, b, gpu
  `).run(...args);
  d.prepare("INSERT OR REPLACE INTO rollups VALUES (?, ?)").run(dst, to);
}

/** Roll raw polls up into the coarser tiers, then drop what is past each tier's retention. Run about once a minute. */
export function maintainHistory(retentionDays: number, now = Date.now() / 1000) {
  tx((d) => {
    for (let i = 1; i < TIERS.length; i++) rollup(d, TIERS[i - 1].res, TIERS[i].res, now);
    for (const { res, keep } of TIERS) {
      const cutoff = Math.floor(now - Math.min(keep, retentionDays * DAY));
      d.prepare("DELETE FROM samples WHERE res = ? AND t < ?").run(res, cutoff);
      d.prepare("DELETE FROM gpu_samples WHERE res = ? AND t < ?").run(res, cutoff);
    }
  });
}

// ============================================================================ jobs
export interface StoredJob {
  info: JobInfo;
  path: string;
  body: unknown;
}

export function saveJob(job: StoredJob) {
  db().prepare("INSERT OR REPLACE INTO jobs VALUES (?, ?, ?, ?)")
    .run(job.info.id, JSON.stringify(job.info), job.path, JSON.stringify(job.body));
}

export function deleteJobs(ids: string[]) {
  if (!ids.length) return;
  tx((d) => {
    const del = d.prepare("DELETE FROM jobs WHERE id = ?");
    for (const id of ids) del.run(id);
  });
}

export function loadJobs(): StoredJob[] {
  const rows = db().prepare("SELECT info, path, body FROM jobs").all() as { info: string; path: string; body: string }[];
  return rows.map((r) => ({ info: JSON.parse(r.info) as JobInfo, path: r.path, body: JSON.parse(r.body) as unknown }));
}
