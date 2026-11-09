import "server-only";
import crypto from "node:crypto";
import http from "node:http";
import tls from "node:tls";
import {
  loadSettings, makeId, normalizeFingerprint, normalizeTags, normalizeUrl, saveLearnedPins, saveUiInstances,
  type Instance, type InstanceInput, type Settings,
} from "./config";
import {
  deleteHistory, deleteJobs, interruptBenchmarks, loadJobs, maintainHistory, modelEvents, recordModelSizes, recordObservations, recordSamples, saveJob, trimAudit,
  type ObservedSpan,
} from "./db";
import { evaluateAlerts, forgetAlerts, type PolledHost } from "./alerts";
import { diagnoseGpu, isGpuLogLine, modelKey, ollamaRun, onCpu, readLog, type GpuEvidence } from "./gpucheck";
import { HttpError } from "./http-error";
import { agentProtocol, incompatibleText, protocolCompat, type AgentIncompatible } from "./protocol";
import {
  RELOAD_WINDOW_S, contextCheck, loadStats, reloadChurn, unseenLoads, type LoadStats, type ModelInfo,
} from "./modelcheck";
import { fitEnv, settingsKey } from "./fit";
import { nativeContext, parseParameters } from "./params";
import { startNotifications } from "./notify";
import { dashboardChecks, forgetDismissals, hostChecks, probeOllama, summarize, type OllamaProbe } from "./security";
import { forgetRequests, syncRequests } from "./requests";
import { isCloudModel, withSplit } from "./split";
import {
  DASHBOARD_TARGET,
  type AgentGpuCheck, type AgentStats, type EnvState, type FitHost, type FitMeasurement, type GpuCheck, type GpuFixAction, type HistoryPoint, type HostEvent,
  type InstanceSnapshot, type JobInfo, type LoadedModel, type PsModel, type ReloadChurn, type SecurityCheck, type SecurityTarget,
} from "./types";

// ============================================================================ errors
export { HttpError };

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
  /** the agent protocol it speaks; null until it answers */
  agent_protocol: number | null = null;
  /** set while it speaks a protocol this dashboard doesn't support: the only call made to it is the poll */
  agent_incompatible: AgentIncompatible | null = null;
  /** the key the agent presented instead of the pinned one; agent calls stop until it is accepted */
  agent_key_changed: string | null = null;
  /** the key an http:// agent reports having, i.e. it can serve HTTPS */
  agent_https_fingerprint: string | null = null;
  ps: PsModel[] = [];
  stats: AgentStats | null = null;
  updated: number | null = null;
  /** what has been recorded in the events table for this host; see observe() */
  observed: Observation | null = null;
  /** Ollama restarts started from the dashboard that are still running, and when the last one's effects should be over (ms) */
  restarting = 0;
  restart_settled = 0;
  /** what the GPU check last read from the agent; see refreshGpuEvidence() */
  gpu_evidence: GpuEvidence | null = null;
  gpu_reading: Promise<void> | null = null;
  gpu_read_at = 0;
  /** /api/show of each loaded model by digest, for the context check; see refreshModelState() */
  model_info = new Map<string, ModelInfo>();
  model_info_reading = new Set<string>();
  model_info_failed = new Map<string, number>();
  /** Ollama's environment as the agent reported it, read once per run of Ollama */
  ollama_env: { run: string; env: Record<string, string> } | null = null;
  env_reading = false;
  env_failed_at = 0;
  /** load and unload events of about the last hour; null until read from paddock.db */
  model_events: HostEvent[] | null = null;
  /** every model seen loaded since the dashboard started, so an alert about one can resolve after it unloads */
  seen_models = new Set<string>();
  /** model runner starts in Ollama's log (agents from 0.8.0), on the dashboard's clock; null: not read, or the agent can't */
  runner_log: { t: number; starts: number[] } | null = null;
  runner_log_reading = false;
  runner_log_next = 0;
  /** the size last recorded for each model, context and settings; see recordSizes() */
  sizes_recorded = new Map<string, number>();
  /** the security checks' probe of Ollama without its key; see refreshSecurityProbe() */
  security_probe: OllamaProbe | null = null;
  security_probing = false;

  constructor(public inst: Instance) {}

  gpuCheck(): GpuCheck | null {
    return diagnoseGpu(this, this.gpu_evidence);
  }

  env(): Record<string, string> | null {
    return this.ollama_env?.env ?? null;
  }

  loadedModels(): LoadedModel[] {
    return this.ps.map((m) => ({ ...withSplit(m), context: contextCheck(m, this.model_info.get(m.digest), this.env()) }));
  }

  loadStats(): LoadStats[] {
    return loadStats(this.model_events ?? [], this.seen_models, Date.now() / 1000);
  }

  unseenLoads(): number | null {
    return this.runner_log && unseenLoads(this.runner_log.starts, this.model_events ?? [], this.runner_log.t);
  }

  securityChecks(): SecurityCheck[] {
    return hostChecks({
      inst: this.inst, ollama_ok: this.ollama_ok, agent_ok: this.agent_ok, agent_https_fingerprint: this.agent_https_fingerprint,
      env: this.env(), probe: this.security_probe,
    });
  }

  reloadChurn(): ReloadChurn[] {
    return reloadChurn(this.loadStats(), this.unseenLoads(), this.env());
  }

  snapshot(): InstanceSnapshot {
    const i = this.inst;
    return {
      id: i.id, name: i.name, tags: i.tags, ollama_url: i.ollama_url, agent_url: i.agent_url, has_agent: !!i.agent_url,
      has_token: !!i.agent_token, agent_fingerprint: i.agent_fingerprint, agent_fingerprint_in_config: i.agent_fingerprint_in_config,
      agent_key_changed: this.agent_key_changed, agent_https_fingerprint: this.agent_https_fingerprint,
      has_ollama_proxy_key: !!i.ollama_proxy_key, source: i.source,
      ollama_ok: this.ollama_ok, ollama_error: this.ollama_error, agent_ok: this.agent_ok,
      agent_error: this.agent_error, version: this.version, agent_version: this.agent_version,
      agent_protocol: this.agent_protocol, agent_incompatible: this.agent_incompatible, ps: this.loadedModels(), stats: this.stats, gpu_check: this.gpuCheck(),
      reload_churn: this.reloadChurn(), updated: this.updated,
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
    try {
      interruptBenchmarks();
    } catch (e) {
      console.error("[llama-paddock] marking interrupted benchmarks failed:", e);
    }
    startNotifications((id) => (id === DASHBOARD_TARGET ? "the dashboard" : g.__paddock?.instances.get(id)?.inst.name ?? id));
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
    forgetAlerts(id, "the host's address or token was changed");
    forgetRequests(id);
  } else if (
    inst.ollama_proxy_key !== prev.ollama_proxy_key || inst.agent_url !== prev.agent_url || inst.agent_fingerprint !== prev.agent_fingerprint
  ) {
    const next = new InstanceState(inst);
    // same server, so its observed span and events carry on
    next.observed = st.observed;
    next.restarting = st.restarting;
    next.restart_settled = st.restart_settled;
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
  forgetAlerts(id, "the host was removed");
  forgetRequests(id);
  forgetDismissals(id);
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
  fresh.restarting = st.restarting;
  fresh.restart_settled = st.restart_settled;
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
    const answer = a.status === "fulfilled" ? a.value : null;
    const protocol = answer ? agentProtocol(answer.data.protocol) : null;
    const incompatible = protocol === null ? null : protocolCompat(protocol);
    if (answer && protocol !== null && incompatible) {
      agentResult = { ok: false, detail: incompatibleText(protocol, incompatible), fingerprint: answer.fingerprint ?? answer.data.fingerprint ?? null };
    } else if (a.status === "fulfilled" && a.value) {
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

export const ollamaHeaders = (inst: Instance, json: boolean): Record<string, string> => ({
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

/** POST to Ollama for a streamed answer; resolves once the response headers arrive. */
export async function ollamaPost(inst: Instance, path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`${inst.ollama_url}${path}`, {
      method: "POST",
      headers: ollamaHeaders(inst, true),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new HttpError(502, `ollama unreachable: ${errText(e)}`);
  }
  const denied = ollamaAuthError(inst, r.status);
  if (denied) throw new HttpError(502, denied);
  if (!r.ok || !r.body) throw new HttpError(r.ok ? 502 : r.status, await upstreamError(r));
  return r;
}

/** Ollama streams newline-delimited JSON objects. */
export async function* ndjsonLines(r: Response): AsyncGenerator<any> {
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line);
      }
    }
    if (buf.trim()) yield JSON.parse(buf);
  } finally {
    // a consumer that stops early (an error line, a cancelled chat) mustn't leave the upstream open
    reader.cancel().catch(() => undefined);
  }
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
  // an agent on a protocol this dashboard doesn't know may have changed what any other call means
  const live = paddock().instances.get(inst.id);
  if (live?.inst === inst && live.agent_incompatible && path !== "/stats" && path !== "/health") {
    throw new HttpError(409, live.agent_error ?? "incompatible agent");
  }
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

/** Run an Ollama restart asked for in the dashboard, so the alert rules don't take it for a crash. */
export async function expectedRestart<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const st = getState(id);
  st.restarting++;
  try {
    return await fn();
  } finally {
    // the host may have been edited meanwhile; the live state is the one the poller reads
    const live = paddock().instances.get(id) ?? st;
    live.restarting = Math.max(0, live.restarting - 1);
    // a few polls for Ollama to come back and load again
    live.restart_settled = Date.now() + (3 * paddock().settings.poll_interval + 10) * 1000;
  }
}

// ============================================================================ poller
const AGENT_VERSION_RECHECK_MS = 10 * 60_000;

/** Record the protocol an agent reports in /stats; true when this dashboard doesn't support it. */
function agentSpeaks(st: InstanceState, stats: AgentStats | null): boolean {
  if (!stats) return false;
  st.agent_protocol = agentProtocol(stats.protocol);
  st.agent_incompatible = protocolCompat(st.agent_protocol);
  return st.agent_incompatible !== null;
}

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
    } else if (agentSpeaks(st, a.value)) {
      // reachable, but the rest of what it says can't be trusted to mean what this dashboard expects
      st.agent_ok = false;
      st.agent_error = incompatibleText(st.agent_protocol!, st.agent_incompatible!);
      st.stats = null;
      if (typeof a.value?.version === "string") st.agent_version = a.value.version;
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

const polledHost = (st: InstanceState): PolledHost => ({
  id: st.inst.id, t: st.updated!, has_agent: !!st.inst.agent_url,
  ollama_ok: st.ollama_ok, ollama_error: st.ollama_error, agent_ok: st.agent_ok, agent_error: st.agent_error,
  stats: st.stats, ps: st.ps, restart_expected: st.restarting > 0 || Date.now() < st.restart_settled, gpu_check: st.gpuCheck(),
  models: { loaded: st.loadedModels(), stats: st.loadStats(), unseen: st.unseenLoads(), env: st.env() },
  security: st.securityChecks(),
});

/** The dashboard's own security checks, as a host for the alert rules (only "insecure" rules apply to it). */
const polledDashboard = (): PolledHost => ({
  id: DASHBOARD_TARGET, t: Date.now() / 1000, has_agent: false, ollama_ok: true, ollama_error: null, agent_ok: false, agent_error: null,
  stats: null, ps: [], restart_expected: false, gpu_check: null, models: { loaded: [], stats: [], unseen: null, env: null },
  security: dashboardChecks(),
});

const MAINTAIN_EVERY_MS = 60_000;
/** Every this many polls, read the new lines of each host's request log (every 30 s at the default interval). */
const REQUESTS_EVERY_POLLS = 10;

/** Read each reachable agent's new request lines, in the background: a slow agent mustn't hold up polling. */
function syncAllRequests(p: Paddock) {
  // a request's model is loaded by the poll after it, or the one after that
  const lag = 2 * p.settings.poll_interval + 1;
  for (const st of p.instances.values()) {
    const inst = st.inst;
    if (!inst.agent_url || !st.agent_ok || st.agent_key_changed) continue;
    void syncRequests(inst.id, async (path) => (await agentCall(inst, "GET", path, undefined, 30_000)).data, lag);
  }
}

async function pollLoop(p: Paddock) {
  let maintained = 0;
  for (let round = 0; ; round++) {
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
    observed.forEach((st, i) => trackModels(st, changes[i].events));
    try {
      recordModelSizes(observed.flatMap(newSizes));
    } catch (e) {
      console.error("[llama-paddock] saving model sizes failed:", e);
    }
    for (const st of observed) {
      if (wantsGpuEvidence(st)) void refreshGpuEvidence(st);
      refreshModelState(st, p.settings.poll_interval);
    }
    if (round % REQUESTS_EVERY_POLLS === REQUESTS_EVERY_POLLS - 1) syncAllRequests(p);
    for (const st of observed) refreshSecurityProbe(st, round);
    try {
      evaluateAlerts([...observed.map(polledHost), polledDashboard()], [...p.instances.keys(), DASHBOARD_TARGET], gapAfter);
    } catch (e) {
      console.error("[llama-paddock] evaluating alert rules failed:", e);
    }
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
        try {
          trimAudit(p.settings.audit_retention_days);
        } catch (e) {
          console.error("[llama-paddock] trimming the audit log failed:", e);
        }
      }
    } catch (e) {
      console.error("[llama-paddock] saving metric history failed:", e);
    }
    const wait = Math.max(500, p.settings.poll_interval * 1000 - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ============================================================================ security checks
/** Ask Ollama without its key every this many polls (every 30 s at the default interval), and at once for a new or changed host. */
const SECURITY_PROBE_EVERY_POLLS = 10;

function refreshSecurityProbe(st: InstanceState, round: number) {
  if (st.security_probing || !st.inst.ollama_proxy_key) return;
  const scheduled = round % SECURITY_PROBE_EVERY_POLLS === 0;
  if (st.security_probe && !scheduled) return;
  // Ollama's environment says whether its own port is open: wait for the agent to report it, until the next scheduled probe
  if (!st.security_probe && !scheduled && st.agent_ok && !st.env()) return;
  st.security_probing = true;
  void probeOllama(st.inst, st.env())
    .then((r) => {
      st.security_probe = r;
    })
    .catch((e) => console.error(`[llama-paddock] security probe of ${st.inst.id} failed:`, e))
    .finally(() => {
      st.security_probing = false;
    });
}

/** Every host's checks and the dashboard's, for the Security page. */
export function securityReport(): { targets: SecurityTarget[] } & ReturnType<typeof summarize> {
  const p = paddock();
  const targets: SecurityTarget[] = [
    { instance: DASHBOARD_TARGET, name: "Dashboard", checks: dashboardChecks() },
    ...[...p.instances.values()].map((st) => ({ instance: st.inst.id, name: st.inst.name, checks: st.securityChecks() })),
  ];
  return { targets, ...summarize(targets) };
}

// ============================================================================ GPU check
/** At most one read of a host's GPU evidence per this many polls, whatever triggers it. */
const GPU_READ_MIN_POLLS = 5;
/** While the GPU looks lost, read again this often, so the causes follow what changes on the host. */
const GPU_READ_LOST_EVERY_S = 10 * 60;

/**
 * Whether to read the GPU evidence again. It only changes when Ollama restarts (a new log and a new
 * GPU discovery) or a model loads on the CPU (its Modelfile may ask for that), so a healthy host
 * costs one read per run of Ollama.
 */
function wantsGpuEvidence(st: InstanceState): boolean {
  const stats = st.stats;
  if (!st.agent_ok || !st.ollama_ok || !stats?.nvidia.available || !stats.nvidia.gpus.length) return false;
  if (st.gpu_reading || Date.now() - st.gpu_read_at < GPU_READ_MIN_POLLS * paddock().settings.poll_interval * 1000) return false;
  const ev = st.gpu_evidence;
  if (!ev || ev.run !== ollamaRun(stats)) return true;
  if (onCpu(st.ps).some((m) => !(modelKey(m) in ev.models))) return true;
  return st.gpuCheck()?.state === "lost" && Date.now() / 1000 - ev.t > GPU_READ_LOST_EVERY_S;
}

async function readGpuEvidence(inst: Instance, stats: AgentStats, ps: PsModel[]): Promise<GpuEvidence> {
  const cpu = onCpu(ps);
  const [check, env, models] = await Promise.all([
    agent<AgentGpuCheck>(inst, "GET", "/gpu-check", undefined, 70_000).catch((e: unknown) => e as Error),
    agent<EnvState>(inst, "GET", "/env", undefined, 15_000).catch(() => null),
    Promise.all(cpu.map(async (m) => {
      const show = await ollama<{ parameters?: string }>(inst, "POST", "/api/show", { model: m.name }, 10_000).catch(() => null);
      return [modelKey(m), parseParameters(show?.parameters).num_gpu === 0] as const;
    })),
  ]);
  let lines: string[] = [], log_error: string | null = null, log_partial = false;
  if (!(check instanceof Error)) {
    lines = check.log?.lines ?? [];
    log_error = check.log?.error ?? null;
  } else if (check instanceof HttpError && check.status === 404) {
    // agents before 0.8.0: the end of the log is all they serve
    log_partial = true;
    try {
      lines = (await agent<{ lines: string[] }>(inst, "GET", "/logs?lines=2000", undefined, 20_000)).lines.filter(isGpuLogLine);
    } catch (e) {
      log_error = errText(e);
    }
  } else log_error = errText(check);
  return {
    t: Date.now() / 1000, run: ollamaRun(stats), platform: stats.platform ?? "linux", facts: readLog(lines), log_error, log_partial,
    uvm: check instanceof Error ? null : check.nvidia_uvm ?? null,
    // on Linux, effective is what the unit runs with; on Windows, the user's variables over the machine's
    env: env ? { ...env.managed, ...env.effective } : {},
    models: Object.fromEntries(models),
  };
}

function refreshGpuEvidence(st: InstanceState): Promise<void> {
  if (st.gpu_reading) return st.gpu_reading;
  const stats = st.stats;
  if (!stats) return Promise.resolve();
  st.gpu_read_at = Date.now();
  st.gpu_reading = readGpuEvidence(st.inst, stats, st.ps)
    .then((ev) => {
      st.gpu_evidence = ev;
    })
    .catch((e) => console.error(`[llama-paddock] ${st.inst.id}: reading the GPU check's evidence failed:`, e))
    .finally(() => {
      st.gpu_reading = null;
    });
  return st.gpu_reading;
}

/** Read the evidence now, as the Monitor tab's "Check again" asks. */
export async function checkGpu(id: string): Promise<GpuCheck | null> {
  const st = getState(id);
  if (!st.inst.agent_url) throw new HttpError(400, `${st.inst.name} has no agent, which the GPU check needs`);
  await st.gpu_reading;
  await refreshGpuEvidence(st);
  return st.gpuCheck();
}

/** Run one of the GPU check's fixes. Either restarts Ollama, so the next poll reads the evidence of its new run. */
export async function fixGpu(id: string, action: GpuFixAction) {
  const inst = getInstance(id);
  if (!inst.agent_url) throw new HttpError(400, `${inst.name} has no agent`);
  const path = action === "reload_uvm" ? "/gpu/reload-uvm" : "/service/restart";
  return expectedRestart(id, () => agent<{ ok: boolean; stderr?: string }>(inst, "POST", path, undefined, 240_000));
}

// ============================================================================ context and reload warnings
/** A failed /api/show for a model is tried again after this long. */
const MODEL_INFO_RETRY_MS = 60_000;
/** Ollama's log is read for runner starts once per this many polls: only what's new since the last read. */
const RUNNER_LOG_EVERY_POLLS = 20;
/** Agents before 0.8.0 have no /runner-starts; ask again this often, in case one is updated. */
const RUNNER_LOG_UNSUPPORTED_RETRY_MS = 3600_000;

/** Keep the load and unload events of the reload window (and a little more, for the log's lag). */
function trackModels(st: InstanceState, events: HostEvent[]) {
  const now = st.updated!;
  if (st.model_events === null) {
    try {
      // this poll's events aren't stored yet, so they aren't read twice
      st.model_events = modelEvents(st.inst.id, now - 2 * RELOAD_WINDOW_S);
    } catch (e) {
      console.error(`[llama-paddock] ${st.inst.id}: reading model events failed:`, e);
      st.model_events = [];
    }
    for (const e of st.model_events) if (e.kind === "load") st.seen_models.add(e.model!);
  }
  for (const e of events) if (e.kind === "load" || e.kind === "unload") st.model_events.push(e);
  for (const m of st.ps) st.seen_models.add(m.name);
  const old = st.model_events.findIndex((e) => e.t >= now - 2 * RELOAD_WINDOW_S);
  st.model_events.splice(0, old < 0 ? st.model_events.length : old);
}

/** Read what the context and reload warnings need and don't have yet. Each read runs in the background. */
function refreshModelState(st: InstanceState, pollInterval: number) {
  if (!st.ollama_ok) return;
  for (const m of st.ps) {
    const d = m.digest;
    if (!d || isCloudModel(m) || st.model_info.has(d) || st.model_info_reading.has(d)) continue;
    if (Date.now() - (st.model_info_failed.get(d) ?? 0) < MODEL_INFO_RETRY_MS) continue;
    st.model_info_reading.add(d);
    ollama<{ parameters?: string; model_info?: Record<string, unknown> }>(st.inst, "POST", "/api/show", { model: m.name }, 10_000)
      .then((show) => {
        const n = parseParameters(show.parameters).num_ctx;
        st.model_info.set(d, { max: nativeContext(show.model_info), num_ctx: typeof n === "number" && n > 0 ? n : null });
      })
      .catch(() => st.model_info_failed.set(d, Date.now()))
      .finally(() => st.model_info_reading.delete(d));
  }

  if (!st.agent_ok || !st.stats) return;
  const run = ollamaRun(st.stats);
  if (!st.env_reading && st.ollama_env?.run !== run && Date.now() - st.env_failed_at >= MODEL_INFO_RETRY_MS) {
    st.env_reading = true;
    agent<EnvState>(st.inst, "GET", "/env", undefined, 15_000)
      .then((env) => {
        // on Linux, effective is what the unit runs with; on Windows, the user's variables over the machine's
        st.ollama_env = { run, env: { ...env.managed, ...env.effective } };
      })
      .catch(() => {
        st.env_failed_at = Date.now();
      })
      .finally(() => {
        st.env_reading = false;
      });
  }
  if (!st.runner_log_reading && Date.now() >= st.runner_log_next) {
    st.runner_log_reading = true;
    void readRunnerLog(st).finally(() => {
      st.runner_log_reading = false;
    });
    st.runner_log_next = Date.now() + RUNNER_LOG_EVERY_POLLS * pollInterval * 1000;
  }
}

async function readRunnerLog(st: InstanceState) {
  const now = Date.now() / 1000;
  const prev = st.runner_log;
  // after the first read, only what's new, overlapping the last read for lines logged while it ran
  const since = prev ? Math.max(prev.t - 60, now - RELOAD_WINDOW_S) : now - RELOAD_WINDOW_S;
  try {
    const r = await agent<{ ts: number; starts?: number[]; error?: string }>(
      st.inst, "GET", `/runner-starts?since=${Math.floor(since)}`, undefined, 40_000,
    );
    if (r.error || !Array.isArray(r.starts)) {
      // the agent can't read Ollama's log (dry run, no journal access): counts stay a minimum
      st.runner_log = null;
      return;
    }
    // the agent's clock may be off from the dashboard's, which the poll events use
    const skew = Date.now() / 1000 - r.ts;
    const fresh = r.starts.map((t) => t + skew).filter((t) => t >= since);
    const kept = (prev?.starts ?? []).filter((t) => t < since && t >= now - 2 * RELOAD_WINDOW_S);
    st.runner_log = { t: r.ts + skew, starts: [...kept, ...fresh] };
  } catch (e) {
    st.runner_log = null;
    if (e instanceof HttpError && e.status === 404) st.runner_log_next = Date.now() + RUNNER_LOG_UNSUPPORTED_RETRY_MS;
  }
}

// ============================================================================ fit estimates
/**
 * Loaded models whose size at this context and these settings hasn't been recorded yet, as fit
 * estimates calibrate against them. Waits for an agent's environment, which decides the settings.
 */
function newSizes(st: InstanceState): (FitMeasurement & { digest: string })[] {
  if (!st.ollama_ok || (st.inst.agent_url && !st.ollama_env)) return [];
  const settings = settingsKey(fitEnv(st.env()));
  const out: (FitMeasurement & { digest: string })[] = [];
  for (const m of st.ps) {
    const ctx = m.context_length;
    if (!m.digest || !ctx || !(m.size > 0) || typeof m.size_vram !== "number" || isCloudModel(m)) continue;
    const key = `${m.digest}|${ctx}|${settings}`;
    if (st.sizes_recorded.get(key) === m.size) continue;
    st.sizes_recorded.set(key, m.size);
    out.push({ instance: st.inst.id, digest: m.digest, context: ctx, settings, size: m.size, size_vram: m.size_vram, t: st.updated! });
  }
  return out;
}

/** A host as fit estimates see it: GPUs, RAM, Ollama's settings and the other loaded models. */
export function fitHost(st: InstanceState, digest: string | null): FitHost {
  const stats = st.agent_ok ? st.stats : null;
  let gpus: FitHost["gpus"] = null;
  if (stats) {
    const other = new Map<string, number>();
    for (const p of stats.nvidia.processes ?? []) {
      if (/ollama/i.test(p.name) || !p.mem_mib) continue;
      other.set(p.gpu_uuid, (other.get(p.gpu_uuid) ?? 0) + p.mem_mib * 1024 * 1024);
    }
    gpus = stats.nvidia.available
      ? stats.nvidia.gpus.filter((g) => g.mem_total_mib).map((g) => ({ index: g.index, name: g.name, total: g.mem_total_mib! * 1024 * 1024, other: other.get(g.uuid) ?? 0 }))
      : [];
  }
  const mem = stats?.system.mem;
  return {
    id: st.inst.id,
    name: st.inst.name,
    gpus,
    ram: mem ? { total: mem.total, available: Math.min(mem.total, mem.available + (stats!.system.ollama_process?.rss_total ?? 0)) } : null,
    env: fitEnv(st.env()),
    loaded: st.ps.filter((m) => m.digest !== digest && !isCloudModel(m)).map((m) => ({ name: m.name, size: m.size, size_vram: m.size_vram ?? 0 })),
  };
}

// ============================================================================ jobs (pull / create / benchmark)
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
  const job = addJob(kind, inst, model, path, body, detail);
  void runJob(job, inst);
  return jobInfo(job);
}

function addJob(kind: Job["kind"], inst: Instance, model: string, path: string, body: unknown, detail: string, id?: string): Job {
  const p = paddock();
  const job: Job = {
    id: id ?? crypto.randomBytes(6).toString("hex"), kind, instance: inst.id, model, detail,
    status: "queued", state: "running", completed: 0, total: 0, error: null,
    started: Date.now() / 1000, finished: null, abort: new AbortController(), path, body, savedAt: 0,
  };
  p.jobs.set(job.id, job);
  persistJob(job);
  return job;
}

/** What a task reports as it goes: shown in the Jobs drawer like a pull's progress. */
export type TaskProgress = (p: { status?: string; completed?: number; total?: number }) => void;

/**
 * A job that is more than one Ollama request, such as a benchmark. It shows in the Jobs drawer and
 * can be cancelled there, which aborts `signal`. After a restart it is marked interrupted, like a create.
 */
export function startTask(
  kind: Job["kind"], inst: Instance, model: string, detail: string, id: string,
  work: (progress: TaskProgress, signal: AbortSignal) => Promise<void>,
): JobInfo {
  const job = addJob(kind, inst, model, "", null, detail, id);
  const progress: TaskProgress = (x) => {
    if (x.status !== undefined) job.status = x.status;
    if (x.completed !== undefined) job.completed = x.completed;
    if (x.total !== undefined) job.total = x.total;
    persistJob(job);
  };
  void tracked(job, () => work(progress, job.abort.signal));
  return jobInfo(job);
}

function runJob(job: Job, inst: Instance) {
  return tracked(job, async () => {
    const r = await ollamaPost(inst, job.path, job.body, job.abort.signal);
    for await (const msg of ndjsonLines(r)) {
      if (msg.error) throw new Error(msg.error);
      const statusChanged = !!msg.status && msg.status !== job.status;
      if (msg.status) job.status = msg.status;
      if (msg.total) {
        job.total = msg.total;
        job.completed = msg.completed ?? 0;
      }
      if (statusChanged || Date.now() - job.savedAt >= SAVE_PROGRESS_EVERY_MS) persistJob(job);
    }
  });
}

/** Run a job's work and record how it ended. */
async function tracked(job: Job, work: () => Promise<void>) {
  try {
    await work();
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
