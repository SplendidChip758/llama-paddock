// Ollama's request log, per host. Every few polls the poller asks each agent for the request lines
// since the last ones read and stores them in paddock.db. The requests that the dashboard and other
// monitors make every few seconds are left out, or they would bury everything else.
import "server-only";
import { insertRequests, lastRequestT, modelsAt, requestStats } from "./db";
import { HttpError } from "./http-error";
import { readJson, writeJson } from "./store";
import type { AgentRequest, RequestSummary } from "./types";

const CLIENTS_FILE = "request-clients.json";

/** Monitoring calls, the dashboard's own among them: not stored. */
const MONITORING = new Set(["GET /", "HEAD /", "GET /api/version", "GET /api/ps"]);
/** Endpoints that run a model, so their requests can be matched to the model loaded at the time. */
const MODEL_PATHS = new Set([
  "/api/generate", "/api/chat", "/api/embed", "/api/embeddings", "/v1/chat/completions", "/v1/completions", "/v1/embeddings",
]);
/** How far back the first read of a host's log goes. */
const FIRST_READ_S = 24 * 3600;
/** Calls one sync may make to catch up, before leaving the rest to the next. */
const MAX_ROUNDS = 8;
/** How often an agent without a request log (before 0.8.0) is asked again, in case it was updated. */
const UNSUPPORTED_RETRY_MS = 3600_000;

export const REQUEST_RANGES = {
  "1h": { seconds: 3600, bucket: 60 },
  "24h": { seconds: 86400, bucket: 900 },
  "7d": { seconds: 7 * 86400, bucket: 3 * 3600 },
  "30d": { seconds: 30 * 86400, bucket: 12 * 3600 },
} as const;
export type RequestRange = keyof typeof REQUEST_RANGES;
export const isRequestRange = (r: string | null): r is RequestRange => r !== null && Object.hasOwn(REQUEST_RANGES, r);

interface AgentRequests {
  requests: AgentRequest[];
  until: number;
  more: boolean;
  skipped: number;
}

interface SyncState {
  /** where the next read starts, in the agent's clock; null until the first read */
  cursor: number | null;
  busy: boolean;
  last_ok: number | null;
  error: string | null;
  unsupported_at: number | null;
  skipped: number;
}

// One per server process, shared by the poller and every route bundle.
const g = globalThis as unknown as { __paddockRequests?: Map<string, SyncState> };
const states = () => (g.__paddockRequests ??= new Map());

function stateOf(id: string): SyncState {
  let s = states().get(id);
  if (!s) states().set(id, (s = { cursor: null, busy: false, last_ok: null, error: null, unsupported_at: null, skipped: 0 }));
  return s;
}

/** Forget where a host's log was read up to: it was removed, or now points at another server. */
export const forgetRequests = (id: string) => states().delete(id);

/** Store what an agent returned: monitoring calls dropped, model-running requests matched to their model where that's clear. */
function store(id: string, requests: AgentRequest[], lag: number) {
  const rows = requests.filter((r) => !MONITORING.has(`${r.method} ${r.path}`)).map((r) => {
    let model: string | null = null;
    // a failed request (an unknown model, a bad body) didn't run on whatever was loaded
    if (MODEL_PATHS.has(r.path) && r.status < 400) {
      const loaded = modelsAt(id, r.t, lag);
      // with several loaded, the log doesn't say which one answered
      if (loaded?.size === 1) model = [...loaded][0];
    }
    return { ...r, model };
  });
  insertRequests(id, rows);
}

/**
 * Read a host's new request lines and store them. `call` makes the agent call (server.ts passes its
 * agentCall), so this module needs none of the server's state. `lag`: seconds after a request in
 * which the poller will have seen its model loaded.
 */
export async function syncRequests(id: string, call: (path: string) => Promise<AgentRequests>, lag: number) {
  const s = stateOf(id);
  if (s.busy || (s.unsupported_at && Date.now() - s.unsupported_at < UNSUPPORTED_RETRY_MS)) return;
  s.busy = true;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const since = s.cursor ?? Math.max(lastRequestT(id) ?? 0, Date.now() / 1000 - FIRST_READ_S);
      const r = await call(`/requests?since=${since}`);
      store(id, r.requests, lag);
      s.cursor = r.until;
      s.skipped += r.skipped;
      s.last_ok = Date.now() / 1000;
      s.error = null;
      s.unsupported_at = null;
      if (!r.more) break;
    }
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) s.unsupported_at = Date.now();
    else s.error = e instanceof Error ? e.message : String(e);
  } finally {
    s.busy = false;
  }
}

// ============================================================================ client names
const ADDRESS_RE = /^[0-9A-Za-z.:%_-]{1,100}$/;
const MAX_NAMES = 500;

/** Names given to client addresses ("open-webui"), shared by every host. */
export function clientNames(): Record<string, string> {
  try {
    const names = readJson<{ names?: Record<string, unknown> }>(CLIENTS_FILE)?.names ?? {};
    return Object.fromEntries(Object.entries(names).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch (e) {
    console.error(`[llama-paddock] can't read ${CLIENTS_FILE}; clients are shown by address:`, e);
    return {};
  }
}

/** Replace the names. A blank name removes the address's entry. */
export function saveClientNames(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "names must be an object of address → name");
  const names: Record<string, string> = {};
  for (const [address, value] of Object.entries(raw)) {
    if (!ADDRESS_RE.test(address)) throw new HttpError(400, `not a client address: ${address.slice(0, 100)}`);
    const name = String(value ?? "").trim().slice(0, 60);
    if (name) names[address] = name;
  }
  if (Object.keys(names).length > MAX_NAMES) throw new HttpError(400, `at most ${MAX_NAMES} names`);
  writeJson(CLIENTS_FILE, { names });
  return names;
}

// ============================================================================ summary
export function requestSummary(id: string, range: RequestRange): RequestSummary {
  const { seconds, bucket } = REQUEST_RANGES[range];
  const to = Date.now() / 1000;
  const from = to - seconds;
  const stats = requestStats(id, from, to, bucket);
  const names = clientNames();
  const s = stateOf(id);
  return {
    range, from, to, bucket_s: bucket, ...stats,
    clients: stats.clients.map((c) => ({ ...c, name: names[c.client] ?? null })),
    sync: { last_ok: s.last_ok, error: s.error, unsupported: s.unsupported_at !== null, skipped: s.skipped },
  };
}
