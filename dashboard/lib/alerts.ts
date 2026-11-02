// Alert rules, evaluated against every poll. A condition has to be observed for a rule's for_s
// before its alert fires, and observed clear for clear_s before it resolves; either streak is
// broken by a poll without the data (agent down, GPU missing, …) and by a gap in polling, so a
// dashboard outage never fires or resolves anything. Rules live in alert-rules.json in the data
// directory; firing and resolved transitions go to paddock.db, so a firing alert is still firing
// after a restart.
import "server-only";
import { firingAlerts, recentFirings, recordAlertTransitions } from "./db";
import { HttpError } from "./http-error";
import { ALERT_KINDS, DEFAULT_CLEAR_S, DEFAULT_RULES, isAlertKind, subjectText } from "./rules";
import { readJson, writeJson } from "./store";
import type { ActiveAlert, AgentStats, AlertRule, AlertTransition, PsModel } from "./types";

const RULES_FILE = "alert-rules.json";

/** An alert that fires this many times within FLAP_WINDOW_S is flapping… */
const FLAP_FIRINGS = 3;
const FLAP_WINDOW_S = 30 * 60;
/** …and then has to stay clear this many times its clear_s (at least FLAP_MIN_CLEAR_S) before it resolves. */
const FLAP_CLEAR_FACTOR = 10;
const FLAP_MIN_CLEAR_S = 10;
const MAX_DURATION_S = 24 * 3600;
/** A model runner has to be missing on this many polls in a row: /api/ps and the agent are asked at slightly different times. */
const RUNNER_MISSING_POLLS = 2;

// ============================================================================ rules
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** hostIds, channelIds: the hosts and channels a rule may name, or null to accept any (rules read back from the file). */
function validRule(raw: unknown, hostIds: Set<string> | null, channelIds: Set<string> | null): Omit<AlertRule, "id"> & { id: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "each rule must be an object");
  const r = raw as Record<string, unknown>;
  if (!isAlertKind(r.kind)) throw new HttpError(400, `kind must be one of ${Object.keys(ALERT_KINDS).join(", ")}`);
  const info = ALERT_KINDS[r.kind];
  const name = String(r.name ?? "").trim().slice(0, 80) || info.label;
  const id = r.id == null || r.id === "" ? null : String(r.id);
  if (id !== null && !ID_RE.test(id)) throw new HttpError(400, `rule id ${id} may only contain letters, digits, _ . -`);

  let threshold: number | null = null;
  if (info.unit) {
    threshold = Number(r.threshold ?? info.threshold);
    const max = info.unit === "%" ? 100 : 150;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > max) {
      throw new HttpError(400, `${name}: threshold must be above 0 and at most ${max}${info.unit}`);
    }
  }
  const seconds = (v: unknown, def: number, what: string) => {
    const n = Number(v ?? def);
    if (!Number.isInteger(n) || n < 0 || n > MAX_DURATION_S) throw new HttpError(400, `${name}: ${what} must be whole seconds from 0 to ${MAX_DURATION_S}`);
    return n;
  };

  let hosts: string[] | null = null;
  if (r.hosts != null) {
    if (!Array.isArray(r.hosts) || !r.hosts.length) throw new HttpError(400, `${name}: hosts must be a non-empty list of host ids, or null for every host`);
    hosts = [...new Set(r.hosts.map(String))];
    const unknown = hostIds ? hosts.filter((h) => !hostIds.has(h)) : [];
    if (unknown.length) throw new HttpError(400, `${name}: unknown host ${unknown.join(", ")}`);
  }

  // an empty list is allowed: the alert shows in the dashboard and isn't sent anywhere
  let channels: string[] | null = null;
  if (r.channels != null) {
    if (!Array.isArray(r.channels)) throw new HttpError(400, `${name}: channels must be a list of channel ids, or null for every channel`);
    channels = [...new Set(r.channels.map(String))];
    const unknown = channelIds ? channels.filter((c) => !channelIds.has(c)) : [];
    if (unknown.length) throw new HttpError(400, `${name}: unknown channel ${unknown.join(", ")}`);
  }

  return {
    id, name, kind: r.kind, enabled: r.enabled !== false, threshold,
    for_s: seconds(r.for_s, info.for_s, "for_s"), clear_s: seconds(r.clear_s, DEFAULT_CLEAR_S, "clear_s"), hosts, channels,
  };
}

function readRules(): AlertRule[] {
  let stored: { rules?: unknown } | null;
  try {
    stored = readJson<{ rules?: unknown }>(RULES_FILE);
  } catch (e) {
    // a broken file must not stop monitoring: use the defaults until the rules are saved again
    console.error(`[llama-paddock] can't read ${RULES_FILE}; using the default alert rules:`, e);
    stored = null;
  }
  if (!Array.isArray(stored?.rules)) return DEFAULT_RULES.map((r) => ({ ...r }));
  // a hand-edited file: keep the rules that make sense, and say which don't
  const rules: AlertRule[] = [];
  const ids = new Set<string>();
  for (const raw of stored.rules) {
    try {
      const r = validRule(raw, null, null);
      if (r.id === null || ids.has(r.id)) throw new HttpError(400, `missing or repeated id ${r.id}`);
      ids.add(r.id);
      rules.push(r as AlertRule);
    } catch (e) {
      console.error(`[llama-paddock] ${RULES_FILE}: skipping a rule: ${(e as Error).message}`);
    }
  }
  return rules;
}

export const listRules = (): AlertRule[] =>
  alerts().rules.map((r) => ({ ...r, hosts: r.hosts && [...r.hosts], channels: r.channels ? [...r.channels] : null }));

/** Validate and store a complete rule list. A rule without an id gets one from its name. */
export function saveRules(raw: unknown, hostIds: string[], channelIds: string[]): AlertRule[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "rules must be a list");
  if (raw.length > 200) throw new HttpError(400, "at most 200 rules");
  const previous = new Map(alerts().rules.map((r) => [r.id, r]));
  const parsed = raw.map((r) => {
    // a host or channel the rule already named may have been removed since, or be gone from config.yaml for now: keep it
    const id = (r as AlertRule | null)?.id;
    const before = typeof id === "string" ? previous.get(id) : undefined;
    const knownHosts = new Set([...hostIds, ...(before?.hosts ?? [])]);
    const knownChannels = new Set([...channelIds, ...(before?.channels ?? [])]);
    return validRule(r, knownHosts, knownChannels);
  });
  const taken = new Set<string>();
  for (const r of parsed) {
    if (r.id === null) continue;
    if (taken.has(r.id)) throw new HttpError(400, `rule ids must be unique: ${r.id}`);
    taken.add(r.id);
  }
  const rules: AlertRule[] = parsed.map((r) => {
    if (r.id !== null) return r as AlertRule;
    const base = r.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "rule";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return { ...r, id };
  });
  writeJson(RULES_FILE, { rules });
  const a = alerts();
  a.rules = rules;
  a.reconcile = true;
  return listRules();
}

const applies = (rule: AlertRule, instance: string) => rule.enabled && (!rule.hosts || rule.hosts.includes(instance));

// ============================================================================ state
interface Tracker extends ActiveAlert {
  /** firing: when the current run of clear observations started; null while the condition holds or is unknown */
  clear_since: number | null;
  /** the last poll that had data for this alert, to tell a gap in observation */
  seen: number | null;
}

/** What the last agent sample said about the Ollama process, to see it restart or lose a runner. */
interface Baseline {
  t: number;
  pid: number | null;
  runner_missing: number;
  /** the agent has counted a runner for every loaded model here; it can't on Ollama versions whose runners are separate binaries */
  counts_runners: boolean;
}

interface AlertsState {
  rules: AlertRule[];
  trackers: Map<string, Tracker>;
  /** recent firing times per alert, for flap detection */
  firings: Map<string, number[]>;
  baselines: Map<string, Baseline>;
  /** check the alerts against the rules and hosts: after a start (restored alerts) and after rules change */
  reconcile: boolean;
  /** the last error saving transitions, so the UI can say alerts may not survive a restart */
  store_error: string | null;
  listeners: Set<(t: AlertTransition) => void>;
}

// One per server process, shared by the poller and every route bundle.
const g = globalThis as unknown as { __paddockAlerts?: AlertsState };

function alerts(): AlertsState {
  if (!g.__paddockAlerts) {
    g.__paddockAlerts = {
      rules: readRules(), trackers: new Map(), firings: new Map(), baselines: new Map(),
      reconcile: true, store_error: null, listeners: new Set(),
    };
    restore(g.__paddockAlerts);
  }
  return g.__paddockAlerts;
}

/** Bring back the alerts that were firing before a restart, and the recent firings that tell flapping apart. */
function restore(a: AlertsState) {
  try {
    for (const x of firingAlerts()) {
      // unknown until the first poll with data: the dashboard wasn't watching in between
      a.trackers.set(keyOf(x.rule, x.instance, x.subject), {
        rule: x.rule, name: x.name, kind: x.kind, instance: x.instance, subject: x.subject, state: "firing",
        since: x.t, fired_at: x.t, value: x.value, detail: x.detail, unknown: true, flapping: x.flapping, clear_since: null, seen: null,
      });
    }
    for (const x of recentFirings(Date.now() / 1000 - FLAP_WINDOW_S)) {
      const key = keyOf(x.rule, x.instance, x.subject);
      a.firings.set(key, [...(a.firings.get(key) ?? []), x.t]);
    }
  } catch (e) {
    a.store_error = e instanceof Error ? e.message : String(e);
    console.error("[llama-paddock] loading firing alerts failed:", e);
  }
}

const keyOf = (rule: string, instance: string, subject: string) => `${rule}\u0000${instance}\u0000${subject}`;

/**
 * Notification channels (#8) and alert history (#9) hook in here: `fn` gets every firing and
 * resolved transition once it has been stored. Returns a function that unsubscribes.
 */
export function onAlertTransition(fn: (t: AlertTransition) => void): () => void {
  const a = alerts();
  a.listeners.add(fn);
  return () => a.listeners.delete(fn);
}

export function activeAlerts(): { active: ActiveAlert[]; store_error: string | null } {
  const a = alerts();
  const active = [...a.trackers.values()].map(({ clear_since: _c, seen: _s, ...x }) => x)
    .sort((x, y) => (x.state === y.state ? x.since - y.since : x.state === "firing" ? -1 : 1));
  return { active, store_error: a.store_error };
}

/**
 * Drop what is known about a host whose history was just deleted (removed, or pointed at another
 * server). Its firing alerts resolve for the listeners; there is no stored history left to add them to.
 */
export function forgetAlerts(instance: string, why: string) {
  const a = alerts();
  const out: AlertTransition[] = [];
  const now = Date.now() / 1000;
  for (const [k, tr] of a.trackers) {
    if (tr.instance !== instance) continue;
    a.trackers.delete(k);
    if (tr.state === "firing") out.push(transition(tr, now, "resolved", `resolved because ${why}`));
  }
  for (const k of a.firings.keys()) if (k.split("\u0000")[1] === instance) a.firings.delete(k);
  a.baselines.delete(instance);
  notify(a, out);
}

// ============================================================================ observations
/** One host's state after a poll, as the poller hands it over. */
export interface PolledHost {
  id: string;
  /** when the poll finished, unix seconds */
  t: number;
  has_agent: boolean;
  ollama_ok: boolean;
  ollama_error: string | null;
  agent_ok: boolean;
  agent_error: string | null;
  /** only meaningful while agent_ok */
  stats: AgentStats | null;
  ps: PsModel[];
  /** Ollama is being restarted from the dashboard, so it going away is expected */
  restart_expected: boolean;
}

/**
 * One observation of an alert's subject. cond: the condition holds (true), doesn't (false) or
 * can't be told from this poll (null). event: something happened that fires at once, without for_s.
 */
interface Observation {
  subject: string;
  cond: boolean | null;
  event?: boolean;
  value: number | null;
  detail: string;
}

const fmtGB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Observations of one rule on one host. Subjects missing from the list have no data in this poll. */
function observe(rule: AlertRule, h: PolledHost, crash: Observation | null): Observation[] {
  const stats = h.agent_ok ? h.stats : null;
  const over = (v: number) => v > rule.threshold!;
  switch (rule.kind) {
    case "gpu_temp":
      return (stats?.nvidia.available ? stats.nvidia.gpus : []).filter((x) => x.temp_c != null).map((x) => ({
        subject: `gpu${x.index}`, cond: over(x.temp_c!), value: x.temp_c,
        detail: `GPU${x.index} (${x.name}) at ${x.temp_c}°C`,
      }));
    case "vram":
      return (stats?.nvidia.available ? stats.nvidia.gpus : []).filter((x) => x.mem_used_mib != null && x.mem_total_mib).map((x) => {
        const pct = round1((x.mem_used_mib! / x.mem_total_mib!) * 100);
        return {
          subject: `gpu${x.index}`, cond: over(pct), value: pct,
          detail: `GPU${x.index} VRAM ${pct}% used (${fmtGB(x.mem_used_mib! * 1024 ** 2)} of ${fmtGB(x.mem_total_mib! * 1024 ** 2)})`,
        };
      });
    case "disk":
      return (stats?.system.disks ?? []).filter((d) => d.total > 0).map((d) => ({
        subject: d.path, cond: over(d.pct), value: d.pct, detail: `${d.path} ${d.pct}% full, ${fmtGB(d.free)} free`,
      }));
    case "host_unreachable": {
      const down = !h.ollama_ok && (!h.has_agent || !h.agent_ok);
      const why = [!h.ollama_ok && `Ollama: ${h.ollama_error ?? "unreachable"}`, h.has_agent && !h.agent_ok && `agent: ${h.agent_error ?? "unreachable"}`];
      return [{ subject: "", cond: down, value: null, detail: down ? why.filter(Boolean).join("; ") : "Ollama answers" }];
    }
    case "agent_unreachable":
      if (!h.has_agent) return [];
      // with Ollama down too, it's the host that is unreachable: that rule's business
      return [{
        subject: "", cond: h.ollama_ok ? !h.agent_ok : null, value: null,
        detail: h.agent_ok ? "the agent answers" : `agent: ${h.agent_error ?? "unreachable"}`,
      }];
    case "ollama_crash":
      return crash ? [crash] : [];
  }
}

/** Ollama's cloud models run remotely, so they have no runner process. */
const isCloud = (m: PsModel) => /[:-]cloud$/.test(m.name);

/** Ollama's API down while the agent answers, a new Ollama process, or a runner gone: computed once per host and poll. */
function observeCrash(a: AlertsState, h: PolledHost, gapAfter: number): Observation | null {
  if (!h.has_agent) return null;
  // without the agent, nothing tells a crash from a network problem. Forget the process too: a
  // different one after an outage or a gap in polling says nothing about when it changed.
  const last = a.baselines.get(h.id);
  if (!h.agent_ok || !h.stats) {
    if (last) a.baselines.set(h.id, { ...last, pid: null, t: 0 });
    return null;
  }
  const prev = last && h.t - last.t <= gapAfter ? last : undefined;
  const proc = h.stats.system.ollama_process;
  const pid = proc?.pid ?? null;
  const local = h.ollama_ok ? h.ps.filter((m) => !isCloud(m)).length : null;
  const counts = !!last?.counts_runners || (!!proc && !!local && proc.runners >= local);
  const missing = counts && proc && local !== null && proc.runners < local ? (prev?.runner_missing ?? 0) + 1 : 0;
  a.baselines.set(h.id, { t: h.t, pid, runner_missing: missing, counts_runners: counts });
  if (h.restart_expected) return null;

  // tasklist on Windows doesn't say which ollama.exe is the server, so only Linux agents' pids are compared
  const linux = (h.stats.platform ?? "linux") === "linux";
  if (prev?.pid != null && pid != null && pid !== prev.pid && linux) {
    return { subject: "", cond: true, event: true, value: null, detail: `Ollama restarted (process ${prev.pid} → ${pid})` };
  }
  if (prev?.pid != null && pid == null) {
    return { subject: "", cond: true, event: true, value: null, detail: "the Ollama process exited" };
  }
  if (!h.ollama_ok) return { subject: "", cond: true, value: null, detail: `Ollama's API is down while the agent answers: ${h.ollama_error ?? "unreachable"}` };
  if (missing >= RUNNER_MISSING_POLLS) {
    return { subject: "", cond: true, event: true, value: proc!.runners, detail: `${proc!.runners} runner process${proc!.runners === 1 ? "" : "es"} for ${local} loaded model${local === 1 ? "" : "s"}: a runner exited` };
  }
  return { subject: "", cond: false, value: null, detail: "Ollama is running" };
}

// ============================================================================ evaluation
function transition(tr: Tracker, t: number, state: AlertTransition["state"], detail = tr.detail): AlertTransition {
  return {
    id: 0, t, rule: tr.rule, name: tr.name, kind: tr.kind, instance: tr.instance, subject: tr.subject,
    state, value: tr.value, detail, flapping: tr.flapping,
  };
}

/** Resolve the alerts that the rules or hosts no longer cover. */
function reconcile(a: AlertsState, hostIds: Set<string>, now: number): AlertTransition[] {
  const out: AlertTransition[] = [];
  const rules = new Map(a.rules.map((r) => [r.id, r]));
  for (const [key, tr] of a.trackers) {
    const rule = rules.get(tr.rule);
    let why: string | null = null;
    if (!rule) why = "the rule was deleted";
    else if (rule.kind !== tr.kind) why = "the rule was changed to another kind";
    else if (!rule.enabled) why = "the rule was disabled";
    else if (!hostIds.has(tr.instance)) why = "the host was removed";
    else if (!applies(rule, tr.instance)) why = "the rule no longer covers this host";
    else tr.name = rule.name;
    if (!why) continue;
    a.trackers.delete(key);
    if (tr.state === "firing") out.push(transition(tr, now, "resolved", `resolved because ${why}`));
  }
  return out;
}

/** Advance one alert by one observation; returns a transition when it fires or resolves. */
function step(a: AlertsState, rule: AlertRule, instance: string, o: Observation, t: number, gapAfter: number): AlertTransition | null {
  const key = keyOf(rule.id, instance, o.subject);
  let tr = a.trackers.get(key);
  // a gap in polling breaks every streak: what happened meanwhile is unknown
  const gap = !tr || tr.seen === null || t - tr.seen > gapAfter;

  if (o.cond === null) {
    if (!tr) return null;
    if (tr.state === "pending") a.trackers.delete(key);
    else {
      tr.unknown = true;
      tr.clear_since = null;
    }
    return null;
  }

  if (!o.cond) {
    if (!tr) return null;
    if (tr.state === "pending") {
      a.trackers.delete(key);
      return null;
    }
    tr.unknown = false;
    if (tr.clear_since === null || gap) tr.clear_since = t;
    tr.seen = t;
    const hold = tr.flapping ? Math.max(rule.clear_s * FLAP_CLEAR_FACTOR, FLAP_MIN_CLEAR_S) : rule.clear_s;
    if (t - tr.clear_since < hold) return null;
    a.trackers.delete(key);
    tr.value = o.value;
    tr.detail = o.detail;
    return transition(tr, t, "resolved");
  }

  if (!tr) {
    tr = {
      rule: rule.id, name: rule.name, kind: rule.kind, instance, subject: o.subject, state: "pending",
      since: t, fired_at: null, value: o.value, detail: o.detail, unknown: false, flapping: false, clear_since: null, seen: t,
    };
    a.trackers.set(key, tr);
  } else if (tr.state === "pending" && gap) tr.since = t;
  tr.value = o.value;
  tr.detail = o.detail;
  tr.unknown = false;
  tr.clear_since = null;
  tr.seen = t;
  if (tr.state === "firing" || (!o.event && t - tr.since < rule.for_s)) return null;

  const recent = (a.firings.get(key) ?? []).filter((x) => x > t - FLAP_WINDOW_S);
  recent.push(t);
  a.firings.set(key, recent);
  tr.state = "firing";
  tr.fired_at = t;
  tr.flapping = recent.length >= FLAP_FIRINGS;
  return transition(tr, t, "firing");
}

/**
 * Evaluate every rule against one round of polls. `hostIds`: every host now configured, so alerts
 * of removed hosts can be dropped. `gapAfter`: seconds without a poll that count as a gap.
 */
export function evaluateAlerts(polled: PolledHost[], hostIds: string[], gapAfter: number) {
  const a = alerts();
  const now = Date.now() / 1000;
  const out: AlertTransition[] = [];
  const ids = new Set(hostIds);
  if (a.reconcile) {
    a.reconcile = false;
    out.push(...reconcile(a, ids, now));
  }

  for (const h of polled) {
    const crash = observeCrash(a, h, gapAfter);
    for (const rule of a.rules) {
      if (!applies(rule, h.id)) continue;
      const seen = new Set<string>();
      for (const o of observe(rule, h, crash)) {
        seen.add(o.subject);
        const x = step(a, rule, h.id, o, h.t, gapAfter);
        if (x) out.push(x);
      }
      // subjects this poll had no data for, such as a GPU that went missing, are unknown, not clear
      for (const tr of a.trackers.values()) {
        if (tr.rule === rule.id && tr.instance === h.id && !seen.has(tr.subject)) {
          step(a, rule, h.id, { subject: tr.subject, cond: null, value: null, detail: "" }, h.t, gapAfter);
        }
      }
    }
  }
  if (!out.length) return;

  try {
    recordAlertTransitions(out);
    a.store_error = null;
  } catch (e) {
    // the alerts still fire and resolve; only a restart could lose track of them
    a.store_error = e instanceof Error ? e.message : String(e);
    console.error("[llama-paddock] saving alert transitions failed:", e);
  }
  notify(a, out);
}

function notify(a: AlertsState, out: AlertTransition[]) {
  for (const x of out) {
    console.log(`[llama-paddock] alert ${x.state}: ${x.name} on ${x.instance}${x.subject ? ` ${subjectText(x.subject)}` : ""}: ${x.detail}`);
    for (const fn of a.listeners) {
      try {
        fn(x);
      } catch (e) {
        console.error("[llama-paddock] an alert listener failed:", e);
      }
    }
  }
}
