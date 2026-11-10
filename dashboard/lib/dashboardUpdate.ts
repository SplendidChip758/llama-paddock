// ===== dashboard updates (#48)
// Whether a newer dashboard is out on this install's channel, and asking the installer's updater to
// install it. The dashboard runs as an unprivileged user and never updates itself: it writes a
// request into its data directory, and a systemd path unit that install/dashboard.sh sets up runs
// update-llama-paddock as root, which backs up, updates, checks the new version and rolls back if
// it doesn't come up. The updater reports back in PADDOCK_UPDATER_DIR, which the service can read.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { version } from "@/package.json";
import { compareVersions } from "./agentReleases";
import type { Settings } from "./config";
import { HttpError } from "./http-error";
import { readJson, writeJson } from "./store";
import type { DashboardRelease, DashboardUpdate, DashboardUpdateRun } from "./types";

export const DASHBOARD_REPO = "SplendidChip758/llama-paddock";
/** Written here, read (and removed) by the root updater. Kept out of backups by paddock-backup. */
export const REQUEST_FILE = "update-request.json";

const FRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 30 * 60_000;
const MAX_RELEASES = 10;
/** A request the updater hasn't picked up after this long is probably never going to be. */
const PICKUP_S = 120;

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
const channel = (): DashboardUpdate["channel"] => (isPre(version) ? "dev" : "stable");

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

async function load(settings: Settings, e: Entry) {
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
    const stable = channel() === "stable";
    const newer: DashboardRelease[] = [];
    for (const rel of list) {
      const tag = rel.tag_name ?? "";
      if (rel.draft || compareVersions(tag, version) === null) continue;
      if (stable && (rel.prerelease || isPre(tag))) continue;
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

function entry(settings: Settings): Entry {
  const key = settings.agent_releases_url;
  let e = g.__paddockDashboardRelease;
  if (!e || e.key !== key) {
    e = g.__paddockDashboardRelease = { releases: [], checked: null, error: null, next: 0, refreshed: 0, loading: null, key };
  }
  return e;
}

/** The cached answer, refreshed in the background when stale: never waits on GitHub. */
function cached(settings: Settings): Entry {
  const e = entry(settings);
  if (settings.update_check && !e.loading && Date.now() >= e.next) {
    e.loading = load(settings, e).finally(() => (e.loading = null));
  }
  return e;
}

/** Ask GitHub again now; at most once a minute, so a click can't use up its rate limit. */
export async function refreshDashboardRelease(settings: Settings) {
  if (!settings.update_check) return;
  const e = entry(settings);
  if (Date.now() - e.refreshed < 60_000) return e.loading ?? undefined;
  e.refreshed = Date.now();
  if (e.loading) await e.loading;
  e.loading = load(settings, e).finally(() => (e.loading = null));
  return e.loading;
}

// ============================================================================ the updater's status
function readStatus(dir: string): DashboardUpdateRun | null {
  let s: Partial<DashboardUpdateRun>;
  try {
    s = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, "status.json"), "utf8"));
  } catch {
    return null;
  }
  let log: string[] = [];
  try {
    log = fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, "update.log"), "utf8")
      // the installer colours its output for a terminal
      .replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(-40);
  } catch {
    // no log yet
  }
  const states: DashboardUpdateRun["state"][] = ["running", "done", "failed", "rolled_back"];
  return {
    state: states.includes(s.state as DashboardUpdateRun["state"]) ? s.state! : "failed",
    version: s.version ?? null,
    from: s.from ?? null,
    started: typeof s.started === "number" ? s.started : null,
    finished: typeof s.finished === "number" ? s.finished : null,
    message: s.message ?? null,
    backup: s.backup ?? null,
    log,
  };
}

interface UpdateRequest {
  version: string;
  requested_by: string | null;
  requested_at: number;
}

function currentRun(dir: string | null): DashboardUpdateRun | null {
  const req = readJson<UpdateRequest>(REQUEST_FILE);
  const status = dir ? readStatus(dir) : null;
  if (!req) return status;
  const waited = Date.now() / 1000 - req.requested_at;
  return {
    state: "requested",
    version: req.version?.replace(/^v/, "") ?? null,
    from: version,
    started: req.requested_at,
    finished: null,
    message: waited > PICKUP_S
      ? "The updater hasn't started. Check it on the dashboard's machine: systemctl status llama-paddock-update.path"
      : null,
    backup: null,
    log: [],
  };
}

export function dashboardUpdate(settings: Settings): DashboardUpdate {
  const method = installMethod();
  const dir = updaterDir();
  const e = settings.update_check ? cached(settings) : null;
  const latest = e?.releases[0]?.version ?? null;
  return {
    current: version,
    channel: channel(),
    check: settings.update_check,
    latest,
    available: !!latest,
    releases: e?.releases ?? [],
    checked: e?.checked ?? null,
    error: e?.error ?? null,
    url: `https://github.com/${DASHBOARD_REPO}/releases`,
    method,
    can_update: method === "installer" && !!dir,
    run: currentRun(dir),
  };
}

/** Ask the installer's updater for `want`, which must be the newest release the dashboard knows of. */
export function requestDashboardUpdate(settings: Settings, want: unknown, user: string | null): DashboardUpdate {
  const u = dashboardUpdate(settings);
  if (u.method === "docker") {
    throw new HttpError(409, "this dashboard runs in Docker: update the image (docker compose pull && docker compose up -d)");
  }
  if (!u.can_update) {
    throw new HttpError(409, u.method === "installer"
      ? "the installer's updater isn't set up here: run update-llama-paddock on the dashboard's machine once"
      : "this dashboard wasn't installed with install/dashboard.sh, so it can't update itself");
  }
  if (!u.check) throw new HttpError(409, "the update check is off (update_check)");
  if (!u.latest) throw new HttpError(409, "no newer release is known");
  if (typeof want !== "string" || want.replace(/^v/, "") !== u.latest) {
    throw new HttpError(409, `${u.latest} is the release to update to`);
  }
  if (u.run?.state === "requested" || u.run?.state === "running") throw new HttpError(409, "an update is already under way");
  // the updater only takes the version from this file, and checks it again before using it
  writeJson(REQUEST_FILE, { version: `v${u.latest}`, requested_by: user, requested_at: Date.now() / 1000 } satisfies UpdateRequest);
  return dashboardUpdate(settings);
}
