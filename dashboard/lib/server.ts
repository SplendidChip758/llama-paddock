import "server-only";
import crypto from "node:crypto";
import http from "node:http";
import tls from "node:tls";
import {
  loadSettings, makeId, normalizeFingerprint, normalizeTags, normalizeUrl, saveLearnedPins, saveUiInstances,
  type Instance, type InstanceInput, type Settings,
} from "./config";
import {
  deleteHistory, deleteJobs, loadJobs, maintainHistory, recordObservations, recordSamples, saveJob, type ObservedSpan,
} from "./db";
import type { AgentStats, HistoryPoint, HostEvent, InstanceSnapshot, JobInfo, PsModel } from "./types";

// ============================================================================ errors
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

/** Wrap a route handler so HttpErrors (and anything else) become {detail} JSON. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.message }, e.status);
      console.error(e);
      return json({ detail: e instanceof Error ? e.message : String(e) }, 500);
    }
  };
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (e.name === "TimeoutError") return "timed out";
    if (cause?.code) return `${cause.code}: ${cause.message ?? e.message}`;
    return e.message;
  }
  return String(e);
}

// ============================================================================ state
class InstanceState {
  ollama_ok = false;
  ollama_error: string | null = null;
  agent_ok = false;
  agent_error: string | null = null;
  version: string | null = null;
  agent_version: string | null = null;
  agent_version_checked = 0;
  /** the key the agent presented instead of the pinned one; agent calls stop until it is accepted */
  agent_key_changed: string | null = null;
  /** the key an http:// agent reports having, i.e. it can serve HTTPS */
  agent_https_fingerprint: string | null = null;
  ps: PsModel[] = [];
  stats: AgentStats | null = null;
  updated: number | null = null;
  /** what has been recorded in the events table for this host; see observe() */
  observed: Observation | null = null;

  constructor(public inst: Instance) {}

  snapshot(): InstanceSnapshot {
    const i = this.inst;
    return {
      id: i.id, name: i.name, tags: i.tags, ollama_url: i.ollama_url, agent_url: i.agent_url, has_agent: !!i.agent_url,
      has_token: !!i.agent_token, agent_fingerprint: i.agent_fingerprint, agent_fingerprint_in_config: i.agent_fingerprint_in_config,
      agent_key_changed: this.agent_key_changed, agent_https_fingerprint: this.agent_https_fingerprint,
      has_ollama_proxy_key: !!i.ollama_proxy_key, source: i.source,
      ollama_ok: this.ollama_ok, ollama_error: this.ollama_error, agent_ok: this.agent_ok,
      agent_error: this.agent_error, version: this.version, agent_version: this.agent_version, ps: this.ps, stats: this.stats, updated: this.updated,
    };
  }
}

interface Observation {
  span: ObservedSpan;
  /** null: not seen yet in this span (agent: or the host has no agent) */
  ollama: boolean | null;
  agent: boolean | null;
  /** loaded models by name; null while Ollama is unreachable, since nothing is known about them then */
  models: Map<string, PsModel> | null;
}

interface Job extends JobInfo {
  abort: AbortController;
  /** The Ollama request, kept so an interrupted pull can be resumed after a restart. */
  path: string;
  body: unknown;
  savedAt: number;
}

interface Paddock {
  settings: Settings;
  instances: Map<string, InstanceState>;
  jobs: Map<string, Job>;
  pollerStarted: boolean;
}

// One instance per server process, shared by instrumentation and every route bundle.
const g = globalThis as unknown as { __paddock?: Paddock };

export function paddock(): Paddock {
  if (!g.__paddock) {
    const settings = loadSettings();
    g.__paddock = {
      settings,
      instances: new Map(settings.instances.map((i) => [i.id, new InstanceState(i)])),
      jobs: new Map(),
      pollerStarted: false,
    };
    restoreJobs(g.__paddock);
  }
  const p = g.__paddock;
  if (!p.pollerStarted) {
    p.pollerStarted = true;
    void pollLoop(p);
  }
  return p;
}

export function getInstance(id: string): Instance {
  const st = paddock().instances.get(id);
  if (!st) throw new HttpError(404, `unknown instance ${id}`);
  return st.inst;
}

export function getState(id: string): InstanceState {
  getInstance(id);
  return paddock().instances.get(id)!;
}

// ============================================================================ hosts added in the UI
/** The same host and port, whether over http:// or https://. */
const sameEndpoint = (a: string | null, b: string | null) => a?.replace(/^https?:/, "") === b?.replace(/^https?:/, "");

function hostFields(body: InstanceInput, existing?: Instance) {
  let ollama_url: string | null, agent_url: string | null;
  let agent_fingerprint: string | null = null;
  try {
    ollama_url = normalizeUrl(body.ollama_url, "Ollama URL");
    agent_url = normalizeUrl(body.agent_url, "Agent URL");
    if (agent_url?.startsWith("https:")) {
      // absent keeps the stored pin (for API clients from before pinning), as long as it's the same agent
      agent_fingerprint = body.agent_fingerprint === undefined
        ? (existing && sameEndpoint(existing.agent_url, agent_url) ? existing.agent_fingerprint : null)
        : normalizeFingerprint(body.agent_fingerprint);
    }
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (!ollama_url) throw new HttpError(400, "Ollama URL is required");
  const name = String(body.name ?? "").trim().slice(0, 80) || new URL(ollama_url).hostname;
  const token = String(body.agent_token ?? "").trim();
  const key = String(body.ollama_proxy_key ?? body.ollama_api_key ?? "").trim();
  return {
    name,
    ollama_url,
    // blank keeps the stored key, so the browser never needs to see it
    ollama_proxy_key: body.clear_ollama_proxy_key === true ? null : key || existing?.ollama_proxy_key || null,
    agent_url,
    // blank keeps the stored token; no agent means no token
    agent_token: agent_url ? token || existing?.agent_token || null : null,
    agent_fingerprint,
    agent_fingerprint_in_config: false,
    tags: normalizeTags(body.tags),
  };
}

function editable(id: string): InstanceState {
  const st = getState(id);
  if (st.inst.source !== "ui") throw new HttpError(409, `${st.inst.name} is defined in config.yaml; edit it there`);
  return st;
}

function persistHosts(p: Paddock) {
  saveUiInstances([...p.instances.values()].map((s) => s.inst));
}

/** Store a changed pin where that host lives: hosts.json, or the learned pins for config.yaml hosts. */
function persistPin(p: Paddock, inst: Instance) {
  if (inst.source === "ui") persistHosts(p);
  else saveLearnedPins([...p.instances.values()].map((s) => s.inst));
}

export function addInstance(body: InstanceInput): Instance {
  const p = paddock();
  const fields = hostFields(body);
  const inst: Instance = { id: makeId(fields.name, new Set(p.instances.keys())), ...fields, source: "ui" };
  p.instances.set(inst.id, new InstanceState(inst));
  // ids can be reused after a host is removed
  deleteHistory(inst.id);
  persistHosts(p);
  return inst;
}

export function updateInstance(id: string, body: InstanceInput): Instance {
  const p = paddock();
  const st = editable(id);
  const prev = st.inst;
  const inst: Instance = { ...prev, ...hostFields(body, prev) };
  // New endpoints mean the old status and history no longer apply. A new Ollama key, the switch to
  // https:// or a new pin don't: it's the same server, so only the status is reset (the next poll fills it in again).
  const moved = inst.ollama_url !== prev.ollama_url || !sameEndpoint(inst.agent_url, prev.agent_url) || inst.agent_token !== prev.agent_token;
  if (moved) {
    p.instances.set(id, new InstanceState(inst));
    deleteHistory(id);
  } else if (
    inst.ollama_proxy_key !== prev.ollama_proxy_key || inst.agent_url !== prev.agent_url || inst.agent_fingerprint !== prev.agent_fingerprint
  ) {
    const next = new InstanceState(inst);
    // same server, so its observed span and events carry on
    next.observed = st.observed;
    p.instances.set(id, next);
  } else st.inst = inst;
  persistHosts(p);
  return inst;
}

export function removeInstance(id: string) {
  const p = paddock();
  editable(id);
  p.instances.delete(id);
  persistHosts(p);
  deleteHistory(id);
}

/** Accept the key an https:// agent presents now, e.g. after its key was replaced. */
export function acceptAgentKey(id: string, value: unknown): Instance {
  const p = paddock();
  const st = getState(id);
  const prev = st.inst;
  if (!prev.agent_url?.startsWith("https:")) throw new HttpError(400, `${prev.name}'s agent isn't addressed with https://`);
  if (prev.agent_fingerprint_in_config) {
    throw new HttpError(409, `${prev.name}'s agent key is pinned in config.yaml; change agent_fingerprint there`);
  }
  let fingerprint: string | null;
  try {
    fingerprint = normalizeFingerprint(value);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (!fingerprint) throw new HttpError(400, "fingerprint is required");
  st.inst = { ...prev, agent_fingerprint: fingerprint };
  st.agent_key_changed = null;
  persistPin(p, st.inst);
  return st.inst;
}

/** Address an http:// agent that reports a key with https://, pinning that key, once it answers over HTTPS with it. */
export async function switchAgentToHttps(id: string): Promise<Instance> {
  const p = paddock();
  const st = editable(id);
  const prev = st.inst;
  if (!prev.agent_url) throw new HttpError(400, `${prev.name} has no agent`);
  if (prev.agent_url.startsWith("https:")) return prev;
  const fingerprint = st.agent_https_fingerprint;
  if (!fingerprint) throw new HttpError(409, `${prev.name}'s agent doesn't offer HTTPS; update it to 0.7.0 or later`);
  const u = new URL(prev.agent_url);
  // the agent serves both on one port, so keep it: an http:// URL without a port means 80, not 443
  const port = u.port || "80";
  u.protocol = "https:";
  u.port = port;
  const next: Instance = { ...prev, agent_url: normalizeUrl(u.href, "Agent URL"), agent_fingerprint: fingerprint };
  try {
    await agentCall(next, "GET", "/health", undefined, 5000);
  } catch (e) {
    throw new HttpError(502, `${prev.name}: the agent doesn't answer over HTTPS with the key it reported (${errText(e)})`);
  }
  if (p.instances.get(id) !== st) throw new HttpError(409, `${prev.name} was changed meanwhile; try again`);
  const fresh = new InstanceState(next);
  fresh.observed = st.observed;
  p.instances.set(id, fresh);
  persistHosts(p);
  return next;
}

export interface CheckResult {
  ok: boolean;
  detail: string;
  /** agent: the key it presented over https://, or reports having over http:// */
  fingerprint?: string | null;
}

/** Try the URLs/token/key from the host form without saving. A blank token or key falls back to the stored one for `id`. */
export async function testConnection(body: InstanceInput & { id?: unknown }) {
  const existing = typeof body.id === "string" ? paddock().instances.get(body.id)?.inst : undefined;
  const f = hostFields(body, existing);
  const probe: Instance = { id: "probe", ...f, source: "ui" };
  const [o, a] = await Promise.allSettled([
    ollama<{ version: string }>(probe, "GET", "/api/version", undefined, 5000),
    probe.agent_url ? agentCall<AgentStats>(probe, "GET", "/stats", undefined, 10_000) : Promise.resolve(null),
  ]);
  const ollamaResult: CheckResult =
    o.status === "fulfilled" ? { ok: true, detail: `Ollama ${o.value.version}` } : { ok: false, detail: errText(o.reason) };
  let agentResult: CheckResult | null = null;
  if (probe.agent_url) {
    if (a.status === "fulfilled" && a.value) {
      const stats = a.value.data;
      const gpus = stats.nvidia?.gpus?.length ?? 0;
      agentResult = {
        ok: true, detail: `${stats.system.hostname} (${stats.platform ?? "linux"}) · ${gpus} GPU${gpus === 1 ? "" : "s"}`,
        fingerprint: a.value.fingerprint ?? stats.fingerprint ?? null,
      };
    } else {
      const reason = a.status === "rejected" ? a.reason : null;
      agentResult = {
        ok: false, detail: reason ? errText(reason) : "no response",
        fingerprint: reason instanceof AgentKeyMismatch ? reason.presented : reason instanceof AgentWantsHttps ? reason.fingerprint : null,
      };
    }
  }
  return { ollama: ollamaResult, agent: agentResult };
}

// ============================================================================ upstream calls
const agentHeaders = (inst: Instance): Record<string, string> =>
  inst.agent_token ? { Authorization: `Bearer ${inst.agent_token}` } : {};

const ollamaHeaders = (inst: Instance, json: boolean): Record<string, string> => ({
  ...(inst.ollama_proxy_key ? { Authorization: `Bearer ${inst.ollama_proxy_key}` } : {}),
  ...(json ? { "Content-Type": "application/json" } : {}),
});

/** A readable message when Ollama (or the proxy in front of it) turns the request away. */
function ollamaAuthError(inst: Instance, status: number): string | null {
  if (status !== 401 && status !== 403) return null;
  // Ollama has no keys of its own, so a 401/403 comes from a proxy in front of it
  return inst.ollama_proxy_key ? `the proxy in front of Ollama rejected the key (${status})` : `the proxy in front of Ollama wants a key (${status})`;
}

function errorDetail(text: string, status: number): string {
  try {
    const j = JSON.parse(text);
    return j.error || j.detail || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || `HTTP ${status}`;
  }
}

const upstreamError = async (r: Response) => errorDetail(await r.text(), r.status);

export async function ollama<T = any>(inst: Instance, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${inst.ollama_url}${path}`, {
      method,
      headers: ollamaHeaders(inst, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new HttpError(502, `ollama unreachable: ${errText(e)}`);
  }
  // 502, not the upstream 401/403: the browser treats a 401 as its own session expiring
  const denied = ollamaAuthError(inst, r.status);
  if (denied) throw new HttpError(502, denied);
  if (!r.ok) throw new HttpError(r.status, await upstreamError(r));
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** The agent presented a key other than the pinned one, so something else may be answering at its address. */
export class AgentKeyMismatch extends HttpError {
  constructor(public presented: string, expected: string) {
    super(502, `agent: it presented the key ${presented}, not the pinned ${expected}`);
  }
}

/** The agent only accepts HTTPS (PADDOCK_AGENT_HTTP=off) but is addressed with http://. */
class AgentWantsHttps extends HttpError {
  constructor(message: string, public fingerprint: string | null) {
    super(502, message);
  }
}

const keyFingerprint = (key: crypto.KeyObject) =>
  `SHA256:${crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("base64").replace(/=+$/, "")}`;

interface AgentResponse {
  status: number;
  text: string;
  /** https:// only: the key the agent presented */
  fingerprint: string | null;
}

/**
 * One request to an agent. Agents serve HTTPS with self-signed certificates, so instead of a CA the
 * agent's key is checked against the pin, and the socket is only handed to the request (which
 * carries the token) once it matches. fetch() can't do that without the undici package.
 */
function agentRequest(inst: Instance, method: string, path: string, body: unknown, timeoutMs: number): Promise<AgentResponse> {
  const url = new URL(`${inst.agent_url}${path}`);
  const secure = url.protocol === "https:";
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let fingerprint: string | null = null;
  let socket: tls.TLSSocket | undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...agentHeaders(inst),
        ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
      },
      createConnection: secure ? (_opts, done) => {
        const s = (socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false }));
        s.once("error", (e) => done(e, s));
        s.once("secureConnect", () => {
          fingerprint = keyFingerprint(s.getPeerX509Certificate()!.publicKey);
          if (!inst.agent_fingerprint || fingerprint === inst.agent_fingerprint) return done(null, s);
          s.destroy();
          done(new AgentKeyMismatch(fingerprint, inst.agent_fingerprint), s);
        });
        return undefined;
      } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", fail);
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), fingerprint });
      });
    });
    const fail = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      // a handshake still in progress isn't the request's socket yet
      socket?.destroy();
    }, timeoutMs);
    req.on("error", fail);
    req.end(payload);
  });
}

/** Pin the key that a host's https:// agent presents on its first connection. */
function pinFirstKey(inst: Instance, fingerprint: string) {
  const p = paddock();
  // only the live host: not a connection test, nor a host that was edited meanwhile
  if (p.instances.get(inst.id)?.inst !== inst) return;
  inst.agent_fingerprint = fingerprint;
  console.log(`[llama-paddock] ${inst.id}: pinned the agent's key ${fingerprint}`);
  try {
    persistPin(p, inst);
  } catch (e) {
    console.error(`[llama-paddock] ${inst.id}: saving the agent's key failed; it is pinned until a restart:`, e);
  }
}

/** Call an agent, and also return the key it presented (https://). */
export async function agentCall<T = any>(inst: Instance, method: string, path: string, body?: unknown, timeoutMs = 30_000) {
  if (!inst.agent_url) throw new HttpError(400, `${inst.id} has no agent configured`);
  let r: AgentResponse;
  try {
    r = await agentRequest(inst, method, path, body, timeoutMs);
  } catch (e) {
    if (e instanceof AgentKeyMismatch) throw e;
    if ((e as NodeJS.ErrnoException).code === "ERR_SSL_WRONG_VERSION_NUMBER") {
      throw new HttpError(502, "agent unreachable: it doesn't answer HTTPS. Agents before 0.7.0 only serve http://");
    }
    throw new HttpError(502, `agent unreachable: ${errText(e)}`);
  }
  if (r.fingerprint && !inst.agent_fingerprint) pinFirstKey(inst, r.fingerprint);
  if (r.status === 426) {
    let reported: string | null = null;
    try {
      reported = JSON.parse(r.text).fingerprint ?? null;
    } catch {
      // not an agent's answer
    }
    throw new AgentWantsHttps(`agent: ${errorDetail(r.text, r.status)}`, reported);
  }
  // a wrong agent token must not look like the dashboard session expiring (see ollama())
  if (r.status < 200 || r.status > 299) throw new HttpError(r.status === 401 ? 502 : r.status, `agent: ${errorDetail(r.text, r.status)}`);
  return { data: JSON.parse(r.text) as T, fingerprint: r.fingerprint };
}

export async function agent<T = any>(inst: Instance, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  return (await agentCall<T>(inst, method, path, body, timeoutMs)).data;
}

// ============================================================================ poller
const AGENT_VERSION_RECHECK_MS = 10 * 60_000;

async function pollOne(st: InstanceState): Promise<HistoryPoint> {
  const inst = st.inst;
  // a changed key stops the agent calls until someone accepts it: they would send the token
  const callAgent = !!inst.agent_url && !st.agent_key_changed;
  const [o, a] = await Promise.allSettled([
    Promise.all([
      ollama<{ models: PsModel[] }>(inst, "GET", "/api/ps", undefined, 5000),
      ollama<{ version: string }>(inst, "GET", "/api/version", undefined, 5000).catch(() => null),
    ]),
    callAgent ? agent<AgentStats>(inst, "GET", "/stats", undefined, 8000) : Promise.resolve(null),
  ]);

  if (o.status === "rejected") {
    st.ollama_ok = false;
    st.ollama_error = errText(o.reason);
    st.ps = [];
  } else {
    st.ollama_ok = true;
    st.ollama_error = null;
    st.ps = o.value[0].models ?? [];
    st.version = o.value[1]?.version ?? st.version;
  }

  if (callAgent) {
    if (a.status === "rejected") {
      st.agent_ok = false;
      st.agent_error = errText(a.reason);
      // unless the pin was changed during this poll
      if (a.reason instanceof AgentKeyMismatch && st.inst === inst) st.agent_key_changed = a.reason.presented;
      if (a.reason instanceof AgentWantsHttps) st.agent_https_fingerprint = a.reason.fingerprint;
    } else {
      st.agent_ok = true;
      st.agent_error = null;
      st.stats = a.value;
      st.agent_https_fingerprint = inst.agent_url!.startsWith("http:") ? a.value?.fingerprint ?? null : null;
      if (a.value?.version) st.agent_version = a.value.version;
      else if (Date.now() - st.agent_version_checked > AGENT_VERSION_RECHECK_MS) {
        // agents before 0.6.0 only report their version on /health
        st.agent_version_checked = Date.now();
        st.agent_version = (await agent<{ version?: string }>(inst, "GET", "/health", undefined, 5000).catch(() => null))?.version ?? st.agent_version;
      }
    }
  }

  st.updated = Date.now() / 1000;
  const point: HistoryPoint = { t: st.updated, vram: st.ps.reduce((s, m) => s + (m.size_vram || 0), 0), loaded: st.ps.length };
  if (st.agent_ok && st.stats) {
    point.cpu = st.stats.system.cpu_pct;
    if (st.stats.system.net.rx_bps != null) point.rx = st.stats.system.net.rx_bps;
    if (st.stats.system.net.tx_bps != null) point.tx = st.stats.system.net.tx_bps;
    point.mem = st.stats.system.mem.pct;
    point.gpus = st.stats.nvidia.gpus.map((x) => ({ u: x.util_pct, m: x.mem_used_mib, mt: x.mem_total_mib, t: x.temp_c, p: x.power_w }));
  }
  return point;
}

/**
 * Compare this poll with what was last recorded, and return the span to extend and the events to
 * append. A dashboard restart or a pause in polling longer than `gapAfter` seconds starts a new
 * span, whose first events record the state as found: whatever happened in between is unknown.
 */
function observe(st: InstanceState, gapAfter: number): { span: ObservedSpan; events: HostEvent[] } {
  const instance = st.inst.id;
  const t = st.updated!;
  let o = st.observed;
  if (!o || t - o.span.end > gapAfter) o = st.observed = { span: { id: 0, instance, start: t, end: t }, ollama: null, agent: null, models: null };
  else o.span.end = t;

  const events: HostEvent[] = [];
  if (o.ollama !== st.ollama_ok) {
    events.push({ instance, t, kind: "ollama", first: o.ollama === null, up: st.ollama_ok, ...(st.ollama_ok ? {} : { error: st.ollama_error ?? "" }) });
    o.ollama = st.ollama_ok;
  }
  if (st.inst.agent_url && o.agent !== st.agent_ok) {
    events.push({ instance, t, kind: "agent", first: o.agent === null, up: st.agent_ok, ...(st.agent_ok ? {} : { error: st.agent_error ?? "" }) });
    o.agent = st.agent_ok;
  }
  if (!st.ollama_ok) o.models = null;
  else {
    const model = (kind: "load" | "unload", m: PsModel, first: boolean): HostEvent => ({
      instance, t, kind, first, model: m.name, digest: m.digest,
      ...(m.context_length ? { context_length: m.context_length } : {}), size_vram: m.size_vram,
    });
    // a new digest or context means Ollama loaded the model again, so it counts as an unload and a load
    const same = (a: PsModel, b: PsModel) => a.digest === b.digest && a.context_length === b.context_length;
    const now = new Map(st.ps.map((m) => [m.name, m]));
    const prev = o.models;
    for (const [name, m] of prev ?? []) {
      const n = now.get(name);
      if (!n || !same(n, m)) events.push(model("unload", m, false));
    }
    for (const [name, m] of now) {
      const p = prev?.get(name);
      // prev null: the models weren't known before this poll, so a load may have happened earlier
      if (!p || !same(p, m)) events.push(model("load", m, prev === null));
    }
    o.models = now;
  }
  return { span: o.span, events };
}

const MAINTAIN_EVERY_MS = 60_000;

async function pollLoop(p: Paddock) {
  let maintained = 0;
  for (;;) {
    const started = Date.now();
    const polled = [...p.instances.values()];
    const results = await Promise.allSettled(polled.map(pollOne));
    // skip hosts that were removed or re-pointed while the poll was in flight
    const rows: [string, HistoryPoint][] = [];
    const observed: InstanceState[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && p.instances.get(polled[i].inst.id) === polled[i]) {
        rows.push([polled[i].inst.id, r.value]);
        observed.push(polled[i]);
      }
    });
    // a poll that is late by a few intervals (plus slack for hosts that time out) is a gap in observation
    const gapAfter = 3 * p.settings.poll_interval + 30;
    const changes = observed.map((st) => observe(st, gapAfter));
    try {
      recordObservations(changes.map((c) => c.span), changes.flatMap((c) => c.events));
    } catch (e) {
      console.error("[llama-paddock] saving host events failed:", e);
      // these changes weren't stored, so start over: the next poll opens new spans with the state as found
      for (const st of observed) st.observed = null;
    }
    try {
      recordSamples(rows);
      if (started - maintained >= MAINTAIN_EVERY_MS) {
        maintained = started;
        maintainHistory(p.settings.history_retention_days);
      }
    } catch (e) {
      console.error("[llama-paddock] saving metric history failed:", e);
    }
    const wait = Math.max(500, p.settings.poll_interval * 1000 - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ============================================================================ jobs (pull / create)
export function jobInfo(j: Job): JobInfo {
  const { abort: _abort, path: _path, body: _body, savedAt: _savedAt, ...info } = j;
  return info;
}

const SAVE_PROGRESS_EVERY_MS = 2000;

function persistJob(job: Job) {
  job.savedAt = Date.now();
  try {
    saveJob({ info: jobInfo(job), path: job.path, body: job.body });
  } catch (e) {
    console.error(`[llama-paddock] saving job ${job.id} failed:`, e);
  }
}

/** Bring back the jobs from before a restart. Pulls that were running resume (Ollama keeps the partial download); other running jobs are marked interrupted. */
function restoreJobs(p: Paddock) {
  let stored;
  try {
    stored = loadJobs();
  } catch (e) {
    console.error("[llama-paddock] loading saved jobs failed:", e);
    return;
  }
  for (const { info, path, body } of stored) {
    const job: Job = { ...info, path, body, savedAt: 0, abort: new AbortController() };
    p.jobs.set(job.id, job);
    if (job.state !== "running") continue;
    const inst = p.instances.get(job.instance)?.inst;
    if (job.kind === "pull" && inst) {
      job.status = "resuming after restart";
      persistJob(job);
      void runJob(job, inst);
    } else {
      job.state = "error";
      job.error = inst ? "interrupted: the dashboard restarted" : "interrupted: the dashboard restarted and the host is gone";
      job.finished = Date.now() / 1000;
      persistJob(job);
    }
  }
}

export function listJobs(): JobInfo[] {
  return [...paddock().jobs.values()].map(jobInfo).sort((a, b) => b.started - a.started);
}

export function startJob(kind: Job["kind"], inst: Instance, model: string, path: string, body: unknown, detail = ""): JobInfo {
  const p = paddock();
  const job: Job = {
    id: crypto.randomBytes(6).toString("hex"), kind, instance: inst.id, model, detail,
    status: "queued", state: "running", completed: 0, total: 0, error: null,
    started: Date.now() / 1000, finished: null, abort: new AbortController(), path, body, savedAt: 0,
  };
  p.jobs.set(job.id, job);
  persistJob(job);
  void runJob(job, inst);
  return jobInfo(job);
}

async function runJob(job: Job, inst: Instance) {
  try {
    const r = await fetch(`${inst.ollama_url}${job.path}`, {
      method: "POST",
      headers: ollamaHeaders(inst, true),
      body: JSON.stringify(job.body),
      signal: job.abort.signal,
    });
    if (!r.ok || !r.body) throw new Error(ollamaAuthError(inst, r.status) ?? (await upstreamError(r)));

    // Ollama streams newline-delimited JSON status objects.
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        const statusChanged = !!msg.status && msg.status !== job.status;
        if (msg.status) job.status = msg.status;
        if (msg.total) {
          job.total = msg.total;
          job.completed = msg.completed ?? 0;
        }
        if (statusChanged || Date.now() - job.savedAt >= SAVE_PROGRESS_EVERY_MS) persistJob(job);
      }
    }
    job.state = "done";
    job.status = "success";
  } catch (e) {
    if (job.abort.signal.aborted) {
      job.state = "cancelled";
      job.status = "cancelled";
    } else {
      job.state = "error";
      job.error = errText(e);
    }
  } finally {
    job.finished = Date.now() / 1000;
    persistJob(job);
    // keep the list bounded
    const jobs = paddock().jobs;
    const finished = [...jobs.values()].filter((j) => j.finished).sort((a, b) => a.finished! - b.finished!);
    const old = finished.slice(0, -50);
    for (const j of old) jobs.delete(j.id);
    try {
      deleteJobs(old.map((j) => j.id));
    } catch (e) {
      console.error("[llama-paddock] pruning saved jobs failed:", e);
    }
  }
}

export function cancelJob(id: string) {
  const jobs = paddock().jobs;
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "no such job");
  if (job.state === "running") job.abort.abort();
  else {
    jobs.delete(id);
    deleteJobs([id]);
  }
}

export async function readBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  // A JSON content type forces browsers to preflight cross-origin requests, which the dashboard
  // doesn't answer: a second line behind the same-origin check in proxy.ts.
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "body must be application/json");
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}
