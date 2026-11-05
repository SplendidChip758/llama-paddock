// The audit log: who changed what, from which address, and when. Routes call audit() after a change
// succeeds; the caller (session or API token) is read from the request, as proxy.ts let it in.
import "server-only";
import { clientIp, currentCaller } from "./auth";
import { insertAudit } from "./db";
import { paddock } from "./server";
import type { Instance } from "./config";
import type { AuditAction } from "./types";

type Cookies = Parameters<typeof currentCaller>[0]["cookies"];

/** Next.js hands every route a NextRequest, but most routes here type it as a plain Request. */
function withCookies(req: Request): Parameters<typeof currentCaller>[0] {
  const cookies = (req as Request & { cookies?: Cookies }).cookies;
  if (cookies) return { headers: req.headers, cookies };
  const jar = new Map<string, string>();
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return { headers: req.headers, cookies: { get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined) } };
}

export interface AuditInput {
  action: AuditAction;
  /** a host id; its current name is stored with it */
  instance?: string | null;
  /** the host's name, when the host is already gone (or a benchmark kept it) */
  instanceName?: string | null;
  target?: string | null;
  /** short and free of secrets: names and which keys changed, never values, prompts, passwords or tokens */
  detail?: string;
  /** who, when the request doesn't say yet: the account a sign-in is for */
  user?: string | null;
}

const MAX_DETAIL = 1000;

/**
 * Record one change. Never throws: the change has already happened, so a failed write is logged
 * rather than turned into an error the user would take to mean nothing changed.
 */
export function audit(req: Request, e: AuditInput) {
  try {
    const caller = e.user === undefined ? currentCaller(withCookies(req)) : null;
    const name = e.instanceName ?? (e.instance ? paddock().instances.get(e.instance)?.inst.name : null) ?? null;
    const detail = e.detail ?? "";
    insertAudit({
      t: Date.now() / 1000,
      user: e.user !== undefined ? e.user : caller?.username ?? null,
      credential: caller?.credential?.name ?? null,
      credential_id: caller?.credential?.id ?? null,
      ip: clientIp(req),
      action: e.action,
      instance: e.instance ?? null,
      instance_name: name,
      target: e.target ?? null,
      detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail,
    });
  } catch (err) {
    console.error(`[llama-paddock] writing the audit log failed (${e.action}):`, err);
  }
}

/** "added a, b; changed c; removed d" from two lists keyed by id, compared by their public fields. */
export function listDiff<T extends { id: string; name: string }>(before: T[], after: T[]): string {
  const prev = new Map(before.map((x) => [x.id, x]));
  const next = new Map(after.map((x) => [x.id, x]));
  const added = after.filter((x) => !prev.has(x.id)).map((x) => x.name);
  const removed = before.filter((x) => !next.has(x.id)).map((x) => x.name);
  const changed = after.filter((x) => prev.has(x.id) && JSON.stringify(prev.get(x.id)) !== JSON.stringify(x)).map((x) => x.name);
  return [
    added.length ? `added ${added.join(", ")}` : "",
    changed.length ? `changed ${changed.join(", ")}` : "",
    removed.length ? `removed ${removed.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

/** A new host: where it is. Tokens and keys are only said to be set. */
export function hostSummary(i: Instance): string {
  return [
    `Ollama ${i.ollama_url}`,
    i.agent_url ? `agent ${i.agent_url}${i.agent_token ? " with a token" : ""}` : "no agent",
    i.ollama_proxy_key ? "proxy key set" : "",
    i.tags.length ? `tags ${i.tags.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

/** What an edit changed, with secrets named but never shown. Empty when nothing did. */
export function hostChanges(a: Instance, b: Instance): string {
  const out: string[] = [];
  const shown = (label: string, x: string | null, y: string | null) => {
    if (x !== y) out.push(`${label} ${x ?? "none"} → ${y ?? "none"}`);
  };
  shown("name", a.name, b.name);
  shown("Ollama", a.ollama_url, b.ollama_url);
  shown("agent", a.agent_url, b.agent_url);
  shown("key pin", a.agent_fingerprint, b.agent_fingerprint);
  if (a.agent_token !== b.agent_token) out.push(b.agent_token ? "agent token changed" : "agent token removed");
  if (a.ollama_proxy_key !== b.ollama_proxy_key) out.push(b.ollama_proxy_key ? (a.ollama_proxy_key ? "proxy key changed" : "proxy key set") : "proxy key removed");
  if (a.tags.join(",") !== b.tags.join(",")) out.push(`tags ${a.tags.join(", ") || "none"} → ${b.tags.join(", ") || "none"}`);
  return out.join("; ");
}

/** "failed" when the agent says a restart didn't work; the agent's stderr stays out of the log. */
export function restartOutcome(r: unknown): string {
  return (r as { ok?: unknown } | null)?.ok === false ? "restart failed" : "";
}

/**
 * Which environment variables were set, changed or unset: names only. The agent replaces the managed
 * variables it allows, so an allowed name it held that the request leaves out is unset. `before` is null when the
 * agent couldn't be read first; then every name sent is listed.
 */
export function envChanges(state: { managed: Record<string, string>; allowed?: string[] } | null, vars: Record<string, unknown>): string {
  if (!state) return `sent ${Object.keys(vars).sort().join(", ") || "no variables"}`;
  const added: string[] = [], changed: string[] = [], removed: string[] = [];
  const before = state.managed;
  // the agent keeps variables outside its allowlist whatever the request says (none listed: agents before 0.6.0 allow all)
  const allowed = (k: string) => !state.allowed || state.allowed.some((p) => (p.endsWith("*") ? k.startsWith(p.slice(0, -1)) : k === p));
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in before)) added.push(k);
    else if (before[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in vars) && allowed(k)) removed.push(k);
  const part = (verb: string, l: string[]) => (l.length ? `${verb} ${l.sort().join(", ")}` : "");
  return [part("set", added), part("changed", changed), part("unset", removed)].filter(Boolean).join("; ") || "no changes";
}
