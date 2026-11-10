// ===== dashboard updates (#48)
// Whether a newer dashboard is out on this install's channel, and asking the installer's updater to
// update, roll back, switch channel or turn automatic updates on or off. The dashboard runs as an
// unprivileged user and never changes its own install: it writes a request into its data directory,
// and a systemd path unit that install/dashboard.sh sets up runs llama-paddock-updater as root, which
// checks the request, backs up, installs, checks the new version and rolls back if it doesn't come
// up. The updater reports back in PADDOCK_UPDATER_DIR, which the service can read.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { version } from "@/package.json";
import { compareVersions } from "./agentReleases";
import type { Settings } from "./config";
import { HttpError } from "./http-error";
import { dataDir, readJson, writeJson } from "./store";
import type { DashboardRelease, DashboardUpdate, DashboardUpdateEntry, DashboardUpdateRun } from "./types";

export const DASHBOARD_REPO = "SplendidChip758/llama-paddock";
/** Written here, read (and removed) by the root updater. Kept out of backups by paddock-backup. */
export const REQUEST_FILE = "update-request.json";

const FRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 30 * 60_000;
const MAX_RELEASES = 10;
const MAX_HISTORY = 50;
/** A request the updater hasn't picked up after this long is probably never going to be. */
const PICKUP_S = 120;
/** paddock-backup's names for backups taken before an update. */
const BACKUP_RE = /^\d{8}T\d{6}Z-v[0-9A-Za-z.-]+-pre-update(-\d+)?$/;

interface Entry {
  releases: DashboardRelease[];
  checked: number | null;
  error: string | null;
  next: number;
  refreshed: number;
  loading: Promise<void> | null;
  key: string;
}

const g = globalThis as unknown as { __paddockDashboardRelease?: Entry };

const isPre = (v: string) => /^v?\d+\.\d+\.\d+-/.test(v);

type Method = DashboardUpdate["method"];
/** Set by the installer's service unit and the Docker image. */
function installMethod(): Method {
  const m = process.env.PADDOCK_INSTALL_METHOD;
  return m === "installer" || m === "docker" ? m : "other";
}

/** Where the installer's updater writes its status; null when there is no updater. */
function updaterDir(): string | null {
  const d = process.env.PADDOCK_UPDATER_DIR;
  if (installMethod() !== "installer" || !d) return null;
  return fs.existsSync(/*turbopackIgnore: true*/ d) ? d : null;
}

function readUpdaterFile(dir: string | null, name: string): string | null {
  if (!dir) return null;
  try {
    return fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, name), "utf8");
  } catch {
    return null;
  }
}

/**
 * The releases this install follows. The installer's updater says which channel it is on, which can
 * differ from this version's: an install switched to stable keeps its newer prerelease until a newer
 * stable release is out. Otherwise a prerelease build follows prereleases.
 */
function channel(dir: string | null): DashboardUpdate["channel"] {
  const c = readUpdaterFile(dir, "channel")?.trim();
  if (c === "dev") return "dev";
  if (c === "latest") return "stable";
  return isPre(version) ? "dev" : "stable";
}

async function load(settings: Settings, e: Entry, chan: DashboardUpdate["channel"]) {
  try {
    const r = await fetch(`${settings.agent_releases_url}/repos/${DASHBOARD_REPO}/releases?per_page=50`, {
      headers: { "User-Agent": `llama-paddock/${version}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`${new URL(settings.agent_releases_url).host} answered ${r.status}`);
    const list = (await r.json()) as {
      tag_name?: string; draft?: boolean; prerelease?: boolean; body?: string | null; html_url?: string;
      published_at?: string | null; assets?: { name?: string }[];
    }[];
    if (!Array.isArray(list)) throw new Error("unexpected answer from the releases API");
    const newer: DashboardRelease[] = [];
    for (const rel of list) {
      const tag = rel.tag_name ?? "";
      if (rel.draft || compareVersions(tag, version) === null) continue;
      if (chan === "stable" && (rel.prerelease || isPre(tag))) continue;
      // the installer checks the tarball against SHA256SUMS: a release without them can't be installed
      const names = new Set((rel.assets ?? []).map((a) => a.name ?? ""));
      if (!names.has("SHA256SUMS") || ![...names].some((n) => /^llama-paddock-dashboard-.*\.tar\.gz$/.test(n))) continue;
      if (compareVersions(tag, version)! <= 0) continue;
      newer.push({
        version: tag.replace(/^v/, ""),
        notes: String(rel.body ?? ""),
        url: rel.html_url ?? `https://github.com/${DASHBOARD_REPO}/releases/tag/${tag}`,
        published: rel.published_at ? Date.parse(rel.published_at) / 1000 : null,
      });
    }
    // the list is not reliably newest first
    newer.sort((a, b) => compareVersions(b.version, a.version)!);
    e.releases = newer.slice(0, MAX_RELEASES);
    e.checked = Date.now() / 1000;
    e.error = null;
    e.next = Date.now() + FRESH_MS;
  } catch (err) {
    const x = err as Error;
    e.error = `can't read the dashboard releases: ${x.name === "TimeoutError" ? "timed out" : x.message}`;
    e.next = Date.now() + RETRY_MS;
  }
}

function entry(settings: Settings, chan: DashboardUpdate["channel"]): Entry {
  // a channel switch asks again
  const key = `${chan} ${settings.agent_releases_url}`;
  let e = g.__paddockDashboardRelease;
  if (!e || e.key !== key) {
    e = g.__paddockDashboardRelease = { releases: [], checked: null, error: null, next: 0, refreshed: 0, loading: null, key };
  }
  return e;
}

/** The cached answer, refreshed in the background when stale: never waits on GitHub. */
function cached(settings: Settings, chan: DashboardUpdate["channel"]): Entry {
  const e = entry(settings, chan);
  if (settings.update_check && !e.loading && Date.now() >= e.next) {
    e.loading = load(settings, e, chan).finally(() => (e.loading = null));
  }
  return e;
}

/** Ask GitHub again now; at most once a minute, so a click can't use up its rate limit. */
export async function refreshDashboardRelease(settings: Settings) {
  if (!settings.update_check) return;
  const chan = channel(updaterDir());
  const e = entry(settings, chan);
  if (Date.now() - e.refreshed < 60_000) return e.loading ?? undefined;
  e.refreshed = Date.now();
  if (e.loading) await e.loading;
  e.loading = load(settings, e, chan).finally(() => (e.loading = null));
  return e.loading;
}

// ============================================================================ the updater's status
type Action = DashboardUpdateRun["action"];
const ACTIONS: Action[] = ["update", "rollback", "channel", "automatic"];
const STATES: DashboardUpdateRun["state"][] = ["running", "done", "failed", "rolled_back"];

interface Record {
  state?: string;
  action?: string;
  version?: string | null;
  from?: string | null;
  started?: number;
  finished?: number | null;
  message?: string | null;
  backup?: string | null;
  by?: string | null;
}

function fromRecord(s: Record): Omit<DashboardUpdateRun, "log" | "phase"> {
  return {
    state: STATES.includes(s.state as DashboardUpdateRun["state"]) ? (s.state as DashboardUpdateRun["state"]) : "failed",
    // the updater from 0.10.0 only updated
    action: ACTIONS.includes(s.action as Action) ? (s.action as Action) : "update",
    version: s.version ?? null,
    from: s.from ?? null,
    started: typeof s.started === "number" ? s.started : null,
    finished: typeof s.finished === "number" ? s.finished : null,
    message: s.message ?? null,
    backup: typeof s.backup === "string" && BACKUP_RE.test(s.backup) ? s.backup : null,
    by: s.by ?? null,
  };
}

/** Where a running update is, from the installer's output so far. */
function phaseOf(log: string[]): DashboardUpdateRun["phase"] {
  const has = (re: RegExp) => log.some((l) => re.test(l));
  if (!has(/against SHA256SUMS/)) return "verify";
  if (!has(/Pre-update backup|updating without one/)) return "backup";
  if (!has(/Installed v?\d/)) return "install";
  return "health";
}

function readStatus(dir: string): DashboardUpdateRun | null {
  let s: Record;
  try {
    s = JSON.parse(readUpdaterFile(dir, "status.json") ?? "");
  } catch {
    return null;
  }
  // the installer colours its output for a terminal
  const log = (readUpdaterFile(dir, "update.log") ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-40);
  const run = fromRecord(s);
  return { ...run, log, phase: run.state === "running" ? phaseOf(log) : null };
}

/** A pre-update backup that is still there, and the version it was taken from. */
function backupVersion(name: string | null): string | null {
  if (!name || !BACKUP_RE.test(name)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ path.join(dataDir(), "backups", name, "manifest.json"), "utf8"));
    return m.reason === "pre-update" && typeof m.app_version === "string" ? m.app_version : null;
  } catch {
    return null;
  }
}

/** Finished runs, newest first. A done run can be rolled back while its backup is kept and it is older than this version. */
function readHistory(dir: string | null): DashboardUpdateEntry[] {
  const lines = (readUpdaterFile(dir, "history.jsonl") ?? "").split("\n").filter(Boolean).slice(-MAX_HISTORY).reverse();
  const out: DashboardUpdateEntry[] = [];
  for (const line of lines) {
    let r: Record;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const e = fromRecord(r);
    if (e.state === "running") continue;
    const from = e.from?.replace(/^v/, "") ?? null;
    const can = e.state === "done" && !!from && backupVersion(e.backup) === from && (compareVersions(version, from) ?? 0) > 0;
    out.push({ ...e, can_roll_back: can });
  }
  return out;
}

interface UpdateRequest {
  action: "update" | "rollback" | "channel" | "auto";
  version?: string;
  backup?: string;
  channel?: "latest" | "dev";
  enabled?: boolean;
  requested_by: string | null;
  requested_at: number;
}

function currentRun(dir: string | null, req: UpdateRequest | null): DashboardUpdateRun | null {
  const status = dir ? readStatus(dir) : null;
  // turning automatic updates on or off isn't a run
  if (!req || req.action === "auto") return status;
  const waited = Date.now() / 1000 - req.requested_at;
  return {
    state: "requested",
    action: req.action ?? "update",
    version: req.version?.replace(/^v/, "") ?? null,
    from: version,
    started: req.requested_at,
    finished: null,
    message: waited > PICKUP_S
      ? "The updater hasn't started. Check it on the dashboard's machine: systemctl status llama-paddock-update.path"
      : null,
    backup: req.backup ?? null,
    by: req.requested_by,
    log: [],
    phase: null,
  };
}

export function dashboardUpdate(settings: Settings): DashboardUpdate {
  const method = installMethod();
  const dir = updaterDir();
  const chan = channel(dir);
  const e = settings.update_check ? cached(settings, chan) : null;
  const latest = e?.releases[0]?.version ?? null;
  const req = readJson<UpdateRequest>(REQUEST_FILE);
  // a change the updater hasn't made yet shows as made
  const autoFile = readUpdaterFile(dir, "auto-update")?.trim();
  const auto = req?.action === "auto" && typeof req.enabled === "boolean" ? req.enabled : autoFile === "on";
  return {
    current: version,
    channel: chan,
    check: settings.update_check,
    latest,
    available: !!latest,
    releases: e?.releases ?? [],
    checked: e?.checked ?? null,
    error: e?.error ?? null,
    url: `https://github.com/${DASHBOARD_REPO}/releases`,
    method,
    can_update: method === "installer" && !!dir,
    auto_update: dir ? auto && chan === "stable" : null,
    run: currentRun(dir, req),
    history: readHistory(dir),
  };
}

/** The installer's updater is there and free, or why not. */
function requireUpdater(u: DashboardUpdate) {
  if (u.method === "docker") {
    throw new HttpError(409, "this dashboard runs in Docker: update the image (docker compose pull && docker compose up -d)");
  }
  if (!u.can_update) {
    throw new HttpError(409, u.method === "installer"
      ? "the installer's updater isn't set up here: run update-llama-paddock on the dashboard's machine once"
      : "this dashboard wasn't installed with install/dashboard.sh, so it can't update itself");
  }
  if (u.run?.state === "requested" || u.run?.state === "running" || readJson(REQUEST_FILE)) {
    throw new HttpError(409, "an update is already under way");
  }
}

function request(r: Omit<UpdateRequest, "requested_at">) {
  // the updater checks every field again before using it
  writeJson(REQUEST_FILE, { ...r, requested_at: Date.now() / 1000 } satisfies UpdateRequest);
}

export interface UpdateBody {
  /** update (the default), rollback, channel or auto */
  action?: unknown;
  version?: unknown;
  backup?: unknown;
  channel?: unknown;
  enabled?: unknown;
}

/** Ask the installer's updater for something; returns what to audit. */
export function requestDashboardUpdate(settings: Settings, body: UpdateBody, user: string | null): { target: string; detail: string } {
  const u = dashboardUpdate(settings);
  requireUpdater(u);
  const action = body.action ?? "update";
  switch (action) {
    case "update": {
      if (!u.check) throw new HttpError(409, "the update check is off (update_check)");
      if (!u.latest) throw new HttpError(409, "no newer release is known");
      if (typeof body.version !== "string" || body.version.replace(/^v/, "") !== u.latest) {
        throw new HttpError(409, `${u.latest} is the release to update to`);
      }
      request({ action: "update", version: `v${u.latest}`, requested_by: user });
      return { target: u.latest, detail: `from ${u.current}` };
    }
    case "rollback": {
      const e = u.history.find((h) => h.backup === body.backup && h.can_roll_back);
      if (!e) throw new HttpError(409, "that update can't be rolled back: its pre-update backup is gone, or it isn't older than this version");
      request({ action: "rollback", version: `v${e.from!.replace(/^v/, "")}`, backup: e.backup!, requested_by: user });
      return { target: e.from!, detail: `from ${u.current}, with backup ${e.backup}` };
    }
    case "channel": {
      if (body.channel !== "stable" && body.channel !== "dev") throw new HttpError(400, "channel must be stable or dev");
      if (body.channel === u.channel) throw new HttpError(409, `this install already follows ${body.channel === "dev" ? "prereleases" : "stable releases"}`);
      request({ action: "channel", channel: body.channel === "dev" ? "dev" : "latest", requested_by: user });
      return { target: body.channel, detail: `from ${u.channel}` };
    }
    case "auto": {
      if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
      if (body.enabled && u.channel !== "stable") throw new HttpError(409, "automatic updates are for the stable channel only");
      request({ action: "auto", enabled: body.enabled, requested_by: user });
      return { target: "automatic updates", detail: body.enabled ? "on" : "off" };
    }
    default:
      throw new HttpError(400, "action must be update, rollback, channel or auto");
  }
}
