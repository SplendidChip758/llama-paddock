// Security checks (#83): settings that leave the fleet or the dashboard exposed and are easy to miss.
// Each check says pass, fail or unknown, and how to fix a failure; a failing check can be dismissed
// when it's intended. The poller hands the results to the "insecure" alert kind, so a host that
// slips back sends a notification. Dismissals live in security-dismissals.json in the data directory.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { authEnabled, passwordConcerns } from "./auth";
import type { Instance } from "./config";
import { listCredentials } from "./credentials";
import { HttpError } from "./http-error";
import { isLoopback, lastServed } from "./served";
import { dataDir, mtimeOf, readJson, writeJson } from "./store";
import {
  DASHBOARD_TARGET, type SecurityCheck, type SecurityCheckId, type SecurityDismissal, type SecuritySummary, type SecurityTarget,
} from "./types";

const DISMISS_FILE = "security-dismissals.json";
/** Each check's section in docs/security-checks.md, which says why it matters and how to fix it. */
const DOC = "security-checks.md";

export const SECURITY_CHECKS: Record<SecurityCheckId, { label: string; target: "host" | "dashboard"; anchor: string }> = {
  ollama_open: { label: "Ollama answers without a key", target: "host", anchor: "ollama-answers-without-a-key" },
  agent_http: { label: "Agent over plain HTTP", target: "host", anchor: "agent-over-plain-http" },
  agent_token: { label: "Weak agent token", target: "host", anchor: "weak-agent-token" },
  default_password: { label: "Initial or well-known password", target: "dashboard", anchor: "initial-or-well-known-password" },
  dashboard_http: { label: "Dashboard over plain HTTP", target: "dashboard", anchor: "dashboard-over-plain-http" },
  data_files: { label: "Data files readable by others", target: "dashboard", anchor: "data-files-readable-by-others" },
  api_tokens: { label: "API tokens that never expire", target: "dashboard", anchor: "api-tokens-that-never-expire" },
};

const isCheckId = (x: unknown): x is SecurityCheckId => typeof x === "string" && Object.hasOwn(SECURITY_CHECKS, x);

const doc = (id: SecurityCheckId) => `${DOC}#${SECURITY_CHECKS[id].anchor}`;

type Result = Pick<SecurityCheck, "state" | "detail" | "fix">;

const check = (id: SecurityCheckId, r: Result): SecurityCheck => ({ id, label: SECURITY_CHECKS[id].label, ...r, dismissal: null });

// ============================================================================ dismissals
const g = globalThis as unknown as { __paddockDismissals?: { list: SecurityDismissal[]; mtime: number | null } };

function dismissals(): SecurityDismissal[] {
  const mtime = mtimeOf(DISMISS_FILE);
  const cached = g.__paddockDismissals;
  if (cached && cached.mtime === mtime) return cached.list;
  let list: SecurityDismissal[] = [];
  try {
    const raw = readJson<{ dismissals?: unknown }>(DISMISS_FILE)?.dismissals;
    // a hand-edited file: keep what makes sense
    if (Array.isArray(raw)) list = raw.filter((d): d is SecurityDismissal => !!d && typeof d.instance === "string" && isCheckId(d.check));
  } catch (e) {
    // a broken file must not hide the checks' results: nothing is dismissed until it is saved again
    console.error(`[llama-paddock] can't read ${DISMISS_FILE}:`, e);
  }
  g.__paddockDismissals = { list, mtime };
  return list;
}

function saveDismissals(list: SecurityDismissal[]) {
  writeJson(DISMISS_FILE, { dismissals: list });
  g.__paddockDismissals = { list, mtime: mtimeOf(DISMISS_FILE) };
}

export const listDismissals = () => dismissals().map((d) => ({ ...d }));

/** {instance, check}: keep a check that fails on purpose from counting and alerting. */
export function dismissCheck(raw: unknown, hostIds: string[], user: string | null): SecurityDismissal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "body must be an object");
  const r = raw as Record<string, unknown>;
  if (!isCheckId(r.check)) throw new HttpError(400, `check must be one of ${Object.keys(SECURITY_CHECKS).join(", ")}`);
  const instance = String(r.instance ?? "");
  const forDashboard = SECURITY_CHECKS[r.check].target === "dashboard";
  if (forDashboard ? instance !== DASHBOARD_TARGET : !hostIds.includes(instance)) {
    throw new HttpError(400, forDashboard ? `${r.check} is a check of the dashboard: instance must be ${DASHBOARD_TARGET}` : `unknown host ${instance}`);
  }
  const d: SecurityDismissal = { instance, check: r.check, user, t: Date.now() / 1000 };
  saveDismissals([...dismissals().filter((x) => x.instance !== instance || x.check !== d.check), d]);
  return d;
}

export function undismissCheck(instance: string, id: string): SecurityDismissal {
  const list = dismissals();
  const d = list.find((x) => x.instance === instance && x.check === id);
  if (!d) throw new HttpError(404, "that check isn't dismissed");
  saveDismissals(list.filter((x) => x !== d));
  return d;
}

/** A removed host's dismissals go with it, so a new host with the same id starts with every check. */
export function forgetDismissals(instance: string) {
  const list = dismissals();
  if (list.some((x) => x.instance === instance)) saveDismissals(list.filter((x) => x.instance !== instance));
}

function applyDismissals(target: string, checks: SecurityCheck[]): SecurityCheck[] {
  const list = dismissals();
  return checks.map((c) => {
    const d = list.find((x) => x.instance === target && x.check === c.id) ?? null;
    return { ...c, dismissal: d, state: d && c.state === "fail" ? "dismissed" : c.state };
  });
}

// ============================================================================ Ollama without a key
/** Where Ollama listens, read from OLLAMA_HOST the way Ollama reads it (envconfig.Host). host "" is every interface. */
export function ollamaBind(value: string | undefined): { host: string; port: number } {
  const s = (value ?? "").trim();
  let port = 11434;
  let hostport = s;
  const i = s.indexOf("://");
  if (i >= 0) {
    const scheme = s.slice(0, i).toLowerCase();
    hostport = s.slice(i + 3);
    if (scheme === "http") port = 80;
    else if (scheme === "https") port = 443;
  }
  hostport = hostport.split("/")[0];
  const m = /^(\[[^\]]*\]|[^:]*):(\d+)$/.exec(hostport);
  if (m) return { host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) };
  return { host: hostport.replace(/^\[|\]$/g, "") || "127.0.0.1", port };
}

const everyInterface = (host: string) => host === "" || host === "0.0.0.0" || host === "::";

export interface OllamaProbe {
  /** unix seconds */
  t: number;
  /** URLs that answered /api/version without the key */
  open: string[];
}

async function answersWithoutKey(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(4000), cache: "no-store", redirect: "manual" });
    if (!r.ok) return false;
    return typeof (await r.json())?.version === "string";
  } catch {
    // refused, filtered or not Ollama: either way nothing answers there without the key
    return false;
  }
}

/**
 * For a host whose Ollama is behind a proxy with a key: ask the proxy without the key, and Ollama's own
 * port when OLLAMA_HOST (or, without the agent, the default port) opens it beyond loopback, since that
 * port bypasses the proxy. Hosts without a key need no probe: the dashboard's own calls already show it.
 */
export async function probeOllama(inst: Instance, env: Record<string, string> | null): Promise<OllamaProbe | null> {
  if (!inst.ollama_proxy_key) return null;
  const url = new URL(inst.ollama_url);
  const targets = [inst.ollama_url];
  const bind = ollamaBind(env?.OLLAMA_HOST);
  if (!env || !isLoopback(bind.host)) {
    const host = !env || everyInterface(bind.host) ? url.hostname : bind.host.includes(":") ? `[${bind.host}]` : bind.host;
    const direct = `http://${host}:${bind.port}`;
    if (new URL(direct).origin !== url.origin) targets.push(direct);
  }
  const open = await Promise.all(targets.map(answersWithoutKey));
  return { t: Date.now() / 1000, open: targets.filter((_, i) => open[i]) };
}

// ============================================================================ host checks
/** What the checks need to know about a host, from the poller's state. */
export interface HostFacts {
  inst: Instance;
  ollama_ok: boolean;
  agent_ok: boolean;
  /** the key an http:// agent reports, i.e. it can serve HTTPS */
  agent_https_fingerprint: string | null;
  /** Ollama's environment as the agent reported it; null without the agent or until read */
  env: Record<string, string> | null;
  probe: OllamaProbe | null;
}

function ollamaOpen(h: HostFacts): Result {
  const fix = { label: "Put a proxy with a key in front", doc: doc("ollama_open") };
  const url = new URL(h.inst.ollama_url);
  const bind = h.env ? ollamaBind(h.env.OLLAMA_HOST) : null;
  const bindText = bind && `OLLAMA_HOST binds ${everyInterface(bind.host) ? "every interface" : bind.host}:${bind.port}`;
  if (!h.inst.ollama_proxy_key) {
    if (!h.ollama_ok) return { state: "unknown", detail: "Ollama doesn't answer, so it can't be checked.", fix: null };
    // on loopback, only OLLAMA_HOST tells whether Ollama is also open to the network
    if (isLoopback(url.hostname) && !bind && h.inst.agent_url && h.agent_ok) {
      return { state: "unknown", detail: "Waiting for the agent to report OLLAMA_HOST.", fix: null };
    }
    if (isLoopback(url.hostname) && (!bind || isLoopback(bind.host))) {
      return { state: "pass", detail: bind ? "Ollama only listens on loopback." : "Ollama is reached on loopback. With the agent, its OLLAMA_HOST is checked too.", fix: null };
    }
    const where = !isLoopback(url.hostname) ? `on ${url.host}` : `on the network (${bindText})`;
    return { state: "fail", detail: `Ollama answers ${where} without a key: anyone who can reach it can pull, delete and run models.`, fix };
  }
  if (!h.probe) return { state: "unknown", detail: "Not checked yet.", fix: null };
  if (h.probe.open.length) {
    const viaProxy = h.probe.open.includes(h.inst.ollama_url);
    const detail = viaProxy
      ? `${h.inst.ollama_url} answers without the proxy key: the proxy in front of Ollama doesn't check it.`
      : `Ollama's own port, ${h.probe.open.join(", ")}, answers without the key, around the proxy${bindText ? ` (${bindText})` : ""}.`;
    return { state: "fail", detail, fix };
  }
  return { state: "pass", detail: `The proxy refuses requests without the key${bind && !isLoopback(bind.host) ? ", and Ollama's own port doesn't answer" : ""}.`, fix: null };
}

function agentHttp(h: HostFacts, inst: Instance): Result {
  if (inst.agent_url!.startsWith("https:")) return { state: "pass", detail: "The agent is addressed with https:// and its key is pinned.", fix: null };
  if (h.agent_https_fingerprint) {
    return {
      state: "fail", detail: "The agent serves HTTPS, but the dashboard calls it over plain HTTP: anyone on the network between them can copy its token.",
      fix: inst.source === "ui" ? { label: "Switch to HTTPS", action: "switch_https" } : { label: "Set an https:// agent_url in config.yaml", doc: doc("agent_http") },
    };
  }
  if (!h.agent_ok) return { state: "unknown", detail: "The agent doesn't answer, so it can't tell whether it serves HTTPS.", fix: null };
  return {
    state: "fail", detail: "The agent is called over plain HTTP and doesn't offer HTTPS (agents before 0.7.0): its token crosses the network in clear text.",
    fix: { label: "Update the agent", doc: doc("agent_http") },
  };
}

/** Values that are examples or placeholders, not secrets. */
const PLACEHOLDERS = new Set(["change-me", "changeme", "change_me", "secret", "token", "password", "test", "paddock", "llama-paddock", "agent-token", "your-token"]);
const MIN_TOKEN = 16;

function agentToken(inst: Instance): Result {
  const t = inst.agent_token ?? "";
  const fix = { label: "Give the agent a new token", doc: doc("agent_token") };
  if (!t) return { state: "fail", detail: "No agent token is set for this host.", fix };
  if (PLACEHOLDERS.has(t.toLowerCase())) return { state: "fail", detail: "The agent token is a placeholder from an example.", fix };
  if (t.length < MIN_TOKEN) return { state: "fail", detail: `The agent token is ${t.length} characters long; use at least ${MIN_TOKEN} random ones (the installer makes 43).`, fix };
  if (new Set(t).size <= 2) return { state: "fail", detail: "The agent token repeats one or two characters.", fix };
  return { state: "pass", detail: "The agent token is long enough.", fix: null };
}

export function hostChecks(h: HostFacts): SecurityCheck[] {
  const out = [check("ollama_open", ollamaOpen(h))];
  if (h.inst.agent_url) out.push(check("agent_http", agentHttp(h, h.inst)), check("agent_token", agentToken(h.inst)));
  return applyDismissals(h.inst.id, out);
}

// ============================================================================ dashboard checks
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function defaultPassword(): Result {
  const { handed_over, weak } = passwordConcerns();
  const fix = { label: "Manage users", href: "/users" };
  // counts only: the page is open to viewers, and a list of weak accounts is a list of targets
  const parts = [
    handed_over.length && `${plural(handed_over.length, "account")} still ${handed_over.length === 1 ? "has" : "have"} the password ${handed_over.length === 1 ? "it was" : "they were"} given (from PADDOCK_PASSWORD, the log, or a reset), which works until it's changed at the next sign-in`,
    weak?.length && `${plural(weak.length, "account")} ${weak.length === 1 ? "uses" : "use"} PADDOCK_PASSWORD or a well-known password`,
  ].filter(Boolean);
  if (parts.length) return { state: "fail", detail: `${parts.join("; ")}.`, fix };
  if (weak === null) return { state: "unknown", detail: "Checking the passwords.", fix: null };
  return { state: "pass", detail: "Every account has changed its first password.", fix: null };
}

function dashboardHttp(): Result {
  const s = lastServed();
  if (!s) return { state: "unknown", detail: "Not yet reached from another machine since the dashboard started.", fix: null };
  if (s.https) return { state: "pass", detail: `Last reached over HTTPS as ${s.host}.`, fix: null };
  return {
    state: "fail", detail: `Last reached over plain HTTP as ${s.host}: passwords, session cookies and API tokens cross the network in clear text.`,
    fix: { label: "Put a TLS proxy in front", doc: doc("dashboard_http") },
  };
}

function dataFiles(): Result {
  if (process.platform === "win32") return { state: "unknown", detail: "File modes aren't checked on Windows.", fix: null };
  const dir = dataDir();
  const loose: string[] = [];
  let names: string[];
  try {
    const st = fs.statSync(/*turbopackIgnore: true*/ dir);
    if (st.mode & 0o077) loose.push(`the directory (${(st.mode & 0o777).toString(8)})`);
    names = fs.readdirSync(/*turbopackIgnore: true*/ dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: "pass", detail: "Nothing is stored yet.", fix: null };
    return { state: "unknown", detail: `Can't read the data directory: ${(e as Error).message}`, fix: null };
  }
  for (const name of names.sort()) {
    try {
      const st = fs.lstatSync(/*turbopackIgnore: true*/ path.join(dir, name));
      if (st.isFile() && st.mode & 0o077) loose.push(`${name} (${(st.mode & 0o777).toString(8)})`);
    } catch {
      // removed meanwhile, e.g. a temp file
    }
  }
  if (!loose.length) return { state: "pass", detail: "The data directory and its files are private to the dashboard (700 and 600).", fix: null };
  return {
    state: "fail", detail: `Other users on this machine can read secrets: ${loose.slice(0, 6).join(", ")}${loose.length > 6 ? ` and ${loose.length - 6} more` : ""}.`,
    fix: { label: "Make them private", action: "chmod_data" },
  };
}

/** chmod the data directory to 700 and its files to 600. Returns what couldn't be changed. */
export function fixDataFiles(): { changed: string[]; failed: string[] } {
  const dir = dataDir();
  const changed: string[] = [];
  const failed: string[] = [];
  const set = (p: string, name: string, mode: number) => {
    try {
      const st = fs.lstatSync(/*turbopackIgnore: true*/ p);
      if (!(st.mode & 0o077)) return;
      fs.chmodSync(/*turbopackIgnore: true*/ p, mode);
      changed.push(name);
    } catch (e) {
      failed.push(`${name}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  };
  set(dir, ".", 0o700);
  let names: string[] = [];
  try {
    names = fs.readdirSync(/*turbopackIgnore: true*/ dir);
  } catch (e) {
    failed.push(`.: ${(e as Error).message}`);
  }
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      if (!fs.lstatSync(/*turbopackIgnore: true*/ p).isFile()) continue;
    } catch {
      continue;
    }
    set(p, name, 0o600);
  }
  return { changed, failed };
}

function apiTokens(): Result {
  const now = Date.now() / 1000;
  const forever = listCredentials((c) => c.expires === null).length;
  const live = listCredentials((c) => c.expires === null || c.expires > now).length;
  if (!forever) return { state: "pass", detail: live ? "Every API token expires." : "There are no API tokens.", fix: null };
  return {
    state: "fail", detail: `${plural(forever, "API token")} never ${forever === 1 ? "expires" : "expire"}: a leaked one works until someone revokes it.`,
    fix: { label: "Review API tokens", href: "/tokens" },
  };
}

export function dashboardChecks(): SecurityCheck[] {
  const out: SecurityCheck[] = [];
  // with the login off, an authenticating proxy signs people in and there are no passwords or tokens here
  if (authEnabled()) out.push(check("default_password", defaultPassword()));
  out.push(check("dashboard_http", dashboardHttp()), check("data_files", dataFiles()));
  if (authEnabled()) out.push(check("api_tokens", apiTokens()));
  return applyDismissals(DASHBOARD_TARGET, out);
}

// ============================================================================ report
export function summarize(targets: SecurityTarget[]): SecuritySummary {
  const all = targets.flatMap((t) => t.checks);
  return { failing: all.filter((c) => c.state === "fail").length, dismissed: all.filter((c) => c.state === "dismissed").length };
}
