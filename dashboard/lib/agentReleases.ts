// ===== agent releases (#15)
// Which agent release is the newest, per platform, so the dashboard can flag older agents. Each
// platform's agent is released from its own repository. The answer is cached for hours: GitHub
// allows 60 unauthenticated API calls an hour, and agents are released a few times a month.
import "server-only";
import { version } from "@/package.json";
import type { Settings } from "./config";
import type { AgentReleases, Platform } from "./types";

export const AGENT_REPOS: Record<Platform, string> = {
  linux: "SplendidChip758/llama-paddock-agent",
  windows: "SplendidChip758/llama-paddock-win-agent",
};
/** The release file each platform's updater installs; a release without it (or SHA256SUMS) can't be installed. */
const ASSETS: Record<Platform, string> = { linux: "paddock-agent-linux.mjs", windows: "paddock-agent-windows.mjs" };

const FRESH_MS = 6 * 60 * 60_000;
const RETRY_MS = 30 * 60_000;

interface Entry {
  latest: string | null;
  checked: number | null;
  error: string | null;
  /** when to ask again, and when someone last asked for a fresh answer (ms) */
  next: number;
  refreshed: number;
  loading: Promise<void> | null;
  /** the channel and API the answer is for: a settings change asks again */
  key: string;
}

const g = globalThis as unknown as { __paddockAgentReleases?: Map<Platform, Entry> };
const cache = (g.__paddockAgentReleases ??= new Map());

type Parsed = [number, number, number, string[] | null];

function parse(v: string | null | undefined): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v ?? "");
  return m ? [+m[1], +m[2], +m[3], m[4] ? m[4].split(".") : null] : null;
}

/** Semver order, prereleases before their release; null when either isn't a version. Matches install/agent.sh. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (!x[3] || !y[3]) return (x[3] ? -1 : 0) - (y[3] ? -1 : 0);
  for (let i = 0; i < Math.max(x[3].length, y[3].length); i++) {
    const p = x[3][i], q = y[3][i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    return /^\d+$/.test(p) && /^\d+$/.test(q) ? +p - +q : p < q ? -1 : 1;
  }
  return 0;
}

/** The releases agents are compared with: a prerelease dashboard follows the agents' prereleases too. */
export function agentChannel(settings: Settings): AgentReleases["channel"] {
  if (settings.agent_updates !== "auto") return settings.agent_updates;
  return parse(version)?.[3] ? "dev" : "stable";
}

async function load(platform: Platform, settings: Settings, e: Entry) {
  const channel = agentChannel(settings);
  try {
    const r = await fetch(`${settings.agent_releases_url}/repos/${AGENT_REPOS[platform]}/releases?per_page=30`, {
      headers: { "User-Agent": `llama-paddock/${version}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`${new URL(settings.agent_releases_url).host} answered ${r.status}`);
    const list = (await r.json()) as { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name?: string }[] }[];
    if (!Array.isArray(list)) throw new Error("unexpected answer from the releases API");
    // the list is not reliably newest first, so pick the highest version
    let best: string | null = null;
    for (const rel of list) {
      const tag = rel.tag_name ?? "";
      if (rel.draft || !parse(tag)) continue;
      if (channel === "stable" && (rel.prerelease || parse(tag)![3])) continue;
      const names = new Set((rel.assets ?? []).map((a) => a.name));
      if (!names.has("SHA256SUMS") || !names.has(ASSETS[platform])) continue;
      if (best === null || compareVersions(tag, best)! > 0) best = tag;
    }
    e.latest = best ? best.replace(/^v/, "") : null;
    e.checked = Date.now() / 1000;
    e.error = null;
    e.next = Date.now() + FRESH_MS;
  } catch (err) {
    const x = err as Error;
    // keep the last answer: a release doesn't stop being the newest because GitHub is unreachable
    e.error = `can't read the agent releases: ${x.name === "TimeoutError" ? "timed out" : x.message}`;
    e.next = Date.now() + RETRY_MS;
  }
}

function entry(platform: Platform, settings: Settings): Entry {
  const key = `${agentChannel(settings)} ${settings.agent_releases_url}`;
  let e = cache.get(platform);
  if (!e || e.key !== key) {
    e = { latest: null, checked: null, error: null, next: 0, refreshed: 0, loading: null, key };
    cache.set(platform, e);
  }
  return e;
}

/**
 * The newest agent release for a platform, as far as the dashboard knows now. Never waits on GitHub:
 * a stale answer is refreshed in the background and returned meanwhile.
 */
export function latestAgent(platform: Platform, settings: Settings): string | null {
  if (agentChannel(settings) === "off") return null;
  const e = entry(platform, settings);
  if (!e.loading && Date.now() >= e.next) {
    e.loading = load(platform, settings, e).finally(() => (e.loading = null));
  }
  return e.latest;
}

/** Ask GitHub again now, for every platform; at most once a minute, so a click can't use up its rate limit. */
export async function refreshAgentReleases(settings: Settings) {
  if (agentChannel(settings) === "off") return;
  await Promise.all((Object.keys(AGENT_REPOS) as Platform[]).map((p) => {
    const e = entry(p, settings);
    if (Date.now() - e.refreshed < 60_000) return e.loading;
    e.refreshed = Date.now();
    // a load already under way may have started before the release someone is waiting for
    if (e.loading) return e.loading.then(() => load(p, settings, e));
    e.loading = load(p, settings, e).finally(() => (e.loading = null));
    return e.loading;
  }));
}

export function agentReleases(settings: Settings): AgentReleases {
  const channel = agentChannel(settings);
  const platforms = {} as AgentReleases["platforms"];
  for (const p of Object.keys(AGENT_REPOS) as Platform[]) {
    const url = `https://github.com/${AGENT_REPOS[p]}/releases`;
    if (channel === "off") {
      platforms[p] = { latest: null, checked: null, error: null, url };
      continue;
    }
    latestAgent(p, settings);
    const e = entry(p, settings);
    platforms[p] = { latest: e.latest, checked: e.checked, error: e.error, url };
  }
  return { channel, platforms };
}
