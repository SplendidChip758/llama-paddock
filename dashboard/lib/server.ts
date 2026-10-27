import "server-only";
import crypto from "node:crypto";
import {
  loadSettings, makeId, normalizeTags, normalizeUrl, saveUiInstances, type Instance, type InstanceInput, type Settings,
} from "./config";
import type { AgentStats, HistoryPoint, InstanceSnapshot, JobInfo, PsModel } from "./types";

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
  ps: PsModel[] = [];
  stats: AgentStats | null = null;
  updated: number | null = null;
  history: HistoryPoint[] = [];

  constructor(public inst: Instance, private maxHistory: number) {}

  push(point: HistoryPoint) {
    this.history.push(point);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
  }

  snapshot(): InstanceSnapshot {
    const i = this.inst;
    return {
      id: i.id, name: i.name, tags: i.tags, ollama_url: i.ollama_url, agent_url: i.agent_url, has_agent: !!i.agent_url,
      has_token: !!i.agent_token, source: i.source,
      ollama_ok: this.ollama_ok, ollama_error: this.ollama_error, agent_ok: this.agent_ok,
      agent_error: this.agent_error, version: this.version, ps: this.ps, stats: this.stats, updated: this.updated,
    };
  }
}

interface Job extends JobInfo {
  abort: AbortController;
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
      instances: new Map(settings.instances.map((i) => [i.id, new InstanceState(i, settings.history_points)])),
      jobs: new Map(),
      pollerStarted: false,
    };
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
function hostFields(body: InstanceInput, existing?: Instance) {
  let ollama_url: string | null, agent_url: string | null;
  try {
    ollama_url = normalizeUrl(body.ollama_url, "Ollama URL");
    agent_url = normalizeUrl(body.agent_url, "Agent URL");
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  if (!ollama_url) throw new HttpError(400, "Ollama URL is required");
  const name = String(body.name ?? "").trim().slice(0, 80) || new URL(ollama_url).hostname;
  const token = String(body.agent_token ?? "").trim();
  return {
    name,
    ollama_url,
    agent_url,
    // blank keeps the stored token; no agent means no token
    agent_token: agent_url ? token || existing?.agent_token || null : null,
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

export function addInstance(body: InstanceInput): Instance {
  const p = paddock();
  const fields = hostFields(body);
  const inst: Instance = { id: makeId(fields.name, new Set(p.instances.keys())), ...fields, source: "ui" };
  p.instances.set(inst.id, new InstanceState(inst, p.settings.history_points));
  persistHosts(p);
  return inst;
}

export function updateInstance(id: string, body: InstanceInput): Instance {
  const p = paddock();
  const st = editable(id);
  const prev = st.inst;
  const inst: Instance = { ...prev, ...hostFields(body, prev) };
  // New endpoints mean the old status and history no longer apply.
  const moved = inst.ollama_url !== prev.ollama_url || inst.agent_url !== prev.agent_url || inst.agent_token !== prev.agent_token;
  if (moved) p.instances.set(id, new InstanceState(inst, p.settings.history_points));
  else st.inst = inst;
  persistHosts(p);
  return inst;
}

export function removeInstance(id: string) {
  const p = paddock();
  editable(id);
  p.instances.delete(id);
  persistHosts(p);
}

export interface CheckResult {
  ok: boolean;
  detail: string;
}

/** Try the URLs/token from the host form without saving. A blank token falls back to the stored one for `id`. */
export async function testConnection(body: InstanceInput & { id?: unknown }) {
  const existing = typeof body.id === "string" ? paddock().instances.get(body.id)?.inst : undefined;
  const f = hostFields(body, existing);
  const probe: Instance = { id: "probe", ...f, source: "ui" };
  const [o, a] = await Promise.allSettled([
    ollama<{ version: string }>(probe, "GET", "/api/version", undefined, 5000),
    probe.agent_url ? agent<AgentStats>(probe, "GET", "/stats", undefined, 10_000) : Promise.resolve(null),
  ]);
  const ollamaResult: CheckResult =
    o.status === "fulfilled" ? { ok: true, detail: `Ollama ${o.value.version}` } : { ok: false, detail: errText(o.reason) };
  let agentResult: CheckResult | null = null;
  if (probe.agent_url) {
    if (a.status === "fulfilled" && a.value) {
      const gpus = a.value.nvidia?.gpus?.length ?? 0;
      agentResult = { ok: true, detail: `${a.value.system.hostname} (${a.value.platform ?? "linux"}) · ${gpus} GPU${gpus === 1 ? "" : "s"}` };
    } else {
      agentResult = { ok: false, detail: a.status === "rejected" ? errText(a.reason) : "no response" };
    }
  }
  return { ollama: ollamaResult, agent: agentResult };
}

// ============================================================================ upstream calls
const agentHeaders = (inst: Instance): Record<string, string> =>
  inst.agent_token ? { Authorization: `Bearer ${inst.agent_token}` } : {};

async function upstreamError(r: Response): Promise<string> {
  const text = await r.text();
  try {
    const j = JSON.parse(text);
    return j.error || j.detail || text.slice(0, 300);
  } catch {
    return text.slice(0, 300) || `HTTP ${r.status}`;
  }
}

export async function ollama<T = any>(inst: Instance, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${inst.ollama_url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new HttpError(502, `ollama unreachable: ${errText(e)}`);
  }
  if (!r.ok) throw new HttpError(r.status, await upstreamError(r));
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export async function agent<T = any>(inst: Instance, method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  if (!inst.agent_url) throw new HttpError(400, `${inst.id} has no agent configured`);
  let r: Response;
  try {
    r = await fetch(`${inst.agent_url}${path}`, {
      method,
      headers: { ...agentHeaders(inst), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new HttpError(502, `agent unreachable: ${errText(e)}`);
  }
  if (!r.ok) throw new HttpError(r.status, `agent: ${await upstreamError(r)}`);
  return (await r.json()) as T;
}

// ============================================================================ poller
async function pollOne(st: InstanceState) {
  const inst = st.inst;
  const [o, a] = await Promise.allSettled([
    Promise.all([
      ollama<{ models: PsModel[] }>(inst, "GET", "/api/ps", undefined, 5000),
      ollama<{ version: string }>(inst, "GET", "/api/version", undefined, 5000).catch(() => null),
    ]),
    inst.agent_url ? agent<AgentStats>(inst, "GET", "/stats", undefined, 8000) : Promise.resolve(null),
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

  if (inst.agent_url) {
    if (a.status === "rejected") {
      st.agent_ok = false;
      st.agent_error = errText(a.reason);
    } else {
      st.agent_ok = true;
      st.agent_error = null;
      st.stats = a.value;
    }
  }

  st.updated = Date.now() / 1000;
  const point: HistoryPoint = { t: st.updated, vram: st.ps.reduce((s, m) => s + (m.size_vram || 0), 0), loaded: st.ps.length };
  if (st.agent_ok && st.stats) {
    point.cpu = st.stats.system.cpu_pct;
    point.mem = st.stats.system.mem.pct;
    point.gpus = st.stats.nvidia.gpus.map((x) => ({ u: x.util_pct, m: x.mem_used_mib, mt: x.mem_total_mib, t: x.temp_c, p: x.power_w }));
  }
  st.push(point);
}

async function pollLoop(p: Paddock) {
  for (;;) {
    const started = Date.now();
    await Promise.allSettled([...p.instances.values()].map(pollOne));
    const wait = Math.max(500, p.settings.poll_interval * 1000 - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

// ============================================================================ jobs (pull / create)
export function jobInfo(j: Job): JobInfo {
  const { abort: _abort, ...info } = j;
  return info;
}

export function listJobs(): JobInfo[] {
  return [...paddock().jobs.values()].map(jobInfo).sort((a, b) => b.started - a.started);
}

export function startJob(kind: Job["kind"], inst: Instance, model: string, path: string, body: unknown, detail = ""): JobInfo {
  const p = paddock();
  const job: Job = {
    id: crypto.randomBytes(6).toString("hex"), kind, instance: inst.id, model, detail,
    status: "queued", state: "running", completed: 0, total: 0, error: null,
    started: Date.now() / 1000, finished: null, abort: new AbortController(),
  };
  p.jobs.set(job.id, job);
  void runJob(job, `${inst.ollama_url}${path}`, body);
  return jobInfo(job);
}

async function runJob(job: Job, url: string, body: unknown) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: job.abort.signal,
    });
    if (!r.ok || !r.body) throw new Error(await upstreamError(r));

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
        if (msg.status) job.status = msg.status;
        if (msg.total) {
          job.total = msg.total;
          job.completed = msg.completed ?? 0;
        }
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
    // keep the list bounded
    const jobs = paddock().jobs;
    const finished = [...jobs.values()].filter((j) => j.finished).sort((a, b) => a.finished! - b.finished!);
    for (const old of finished.slice(0, -50)) jobs.delete(old.id);
  }
}

export function cancelJob(id: string) {
  const jobs = paddock().jobs;
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "no such job");
  if (job.state === "running") job.abort.abort();
  else jobs.delete(id);
}

export async function readBody<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}
