// Notification channels: alerts that fire or resolve are sent to webhooks, Discord, Slack or email.
// Channels live in alert-channels.json in the data directory, mode 600, since webhook URLs, tokens
// and SMTP passwords are secrets and never go back to the browser. Each channel has its own queue,
// so its messages arrive in order, and one that is down retries without holding up the others.
// Messages still queued when the dashboard stops are lost.
import "server-only";
import { version } from "@/package.json";
import { listRules, onAlertTransition } from "./alerts";
import { CHANNEL_TYPES, SMTP_PORTS, isChannelType } from "./channels";
import { HttpError } from "./http-error";
import { subjectText } from "./rules";
import { sendMail, type Mail, type SmtpConfig, type SmtpSecurity } from "./smtp";
import { readJson, writeJson } from "./store";
import type { AlertTransition, ChannelStatus, ChannelType, NotifyChannel } from "./types";

const CHANNELS_FILE = "alert-channels.json";
const MAX_CHANNELS = 50;
/** Seconds to wait before each retry of a failed delivery; a Retry-After from the server wins (up to MAX_RETRY_AFTER_S). */
const RETRY_DELAYS_S = [5, 30, 120];
const MAX_RETRY_AFTER_S = 300;
/** Messages a channel may have waiting; more are dropped and the channel says so. */
const MAX_QUEUED = 100;
const WEBHOOK_TIMEOUT_MS = 10_000;

// ============================================================================ channels
interface StoredChannel {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  send_resolved: boolean;
  /** webhook, discord, slack */
  url: string | null;
  /** webhook: sent as Authorization: Bearer */
  token: string | null;
  email: SmtpConfig | null;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// the domain is labels separated by dots, so no part of it can match two ways (CodeQL's polynomial regex check)
const EMAIL_RE = /^[^\s<>@,;:"()[\]\\]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$/;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/**
 * One channel from an API body or the file. A blank url, token or password keeps the stored one
 * from `existing` (the same channel, by id), so the browser never needs to see it.
 */
function validChannel(raw: unknown, existing: StoredChannel | undefined): Omit<StoredChannel, "id"> & { id: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "each channel must be an object");
  const r = raw as Record<string, unknown>;
  if (!isChannelType(r.type)) throw new HttpError(400, `type must be one of ${Object.keys(CHANNEL_TYPES).join(", ")}`);
  const type = r.type;
  const name = str(r.name).slice(0, 80) || CHANNEL_TYPES[type].label;
  const id = str(r.id) || null;
  if (id !== null && !ID_RE.test(id)) throw new HttpError(400, `channel id ${id} may only contain letters, digits, _ . -`);
  // secrets only carry over within the same kind of channel
  const prev = existing?.type === type ? existing : undefined;
  const bad = (msg: string) => new HttpError(400, `${name}: ${msg}`);

  let url: string | null = null, token: string | null = null, email: SmtpConfig | null = null;
  if (type !== "email") {
    const given = str(r.url);
    url = given || prev?.url || null;
    if (!url) throw bad("the URL is required");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw bad("the URL isn't valid");
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || url.length > 2048) throw bad("the URL must be an http:// or https:// address");
    if (type === "webhook") {
      const t = str(r.token);
      token = r.clear_token === true ? null : t || prev?.token || null;
      if (token && (token.length > 1024 || /[\r\n]/.test(token))) throw bad("the token can't be longer than 1024 characters or contain line breaks");
    }
  } else {
    const e = (r.email && typeof r.email === "object" ? r.email : {}) as Record<string, unknown>;
    const security = (str(e.security) || "starttls") as SmtpSecurity;
    if (!Object.hasOwn(SMTP_PORTS, security)) throw bad("security must be tls, starttls or none");
    const host = str(e.host);
    if (!HOST_RE.test(host)) throw bad("the SMTP server must be a host name or IP address");
    const port = e.port == null || e.port === "" ? SMTP_PORTS[security] : Number(e.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad("the port must be from 1 to 65535");
    const username = str(e.username) || null;
    const password = !username || e.clear_password === true ? null : str(e.password) || prev?.email?.password || null;
    if (username && security === "none") throw bad("a login needs TLS or STARTTLS, so the password isn't sent in plain text");
    if (username && !password) throw bad("the password is required with a user name");
    const from = str(e.from);
    if (!EMAIL_RE.test(from)) throw bad("the sender must be an email address");
    const to = [...new Set((Array.isArray(e.to) ? e.to : str(e.to).split(/[,;\s]+/)).map(str).filter(Boolean))];
    if (!to.length || to.length > 20) throw bad("list 1 to 20 recipients");
    const wrong = to.filter((x) => !EMAIL_RE.test(x));
    if (wrong.length) throw bad(`not an email address: ${wrong.join(", ")}`);
    email = { host, port, security, username, password, from, to };
  }
  return { id, name, type, enabled: r.enabled !== false, send_resolved: r.send_resolved !== false, url, token, email };
}

function readChannels(): StoredChannel[] {
  let stored: { channels?: unknown } | null;
  try {
    stored = readJson<{ channels?: unknown }>(CHANNELS_FILE);
  } catch (e) {
    console.error(`[llama-paddock] can't read ${CHANNELS_FILE}; no notifications are sent until it's fixed or the channels are saved again:`, e);
    return [];
  }
  const out: StoredChannel[] = [];
  for (const raw of Array.isArray(stored?.channels) ? stored.channels : []) {
    try {
      const c = validChannel(raw, undefined);
      if (!c.id || out.some((x) => x.id === c.id)) throw new Error(`missing or repeated id ${c.id}`);
      out.push(c as StoredChannel);
    } catch (e) {
      console.error(`[llama-paddock] ${CHANNELS_FILE}: skipping a channel: ${(e as Error).message}`);
    }
  }
  return out;
}

/** "https://discord.com/…": enough to recognise the target without giving away the secret in the path. */
function urlHint(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? "/…" : ""}`;
}

function publicView(n: NotifyState, c: StoredChannel): NotifyChannel {
  return {
    id: c.id, name: c.name, type: c.type, enabled: c.enabled, send_resolved: c.send_resolved,
    url_hint: c.url ? urlHint(c.url) : null, has_token: !!c.token,
    email: c.email && {
      host: c.email.host, port: c.email.port, security: c.email.security, username: c.email.username,
      has_password: !!c.email.password, from: c.email.from, to: [...c.email.to],
    },
    status: { ...statusOf(n, c.id) },
  };
}

export const listChannels = (): NotifyChannel[] => {
  const n = notify();
  return n.channels.map((c) => publicView(n, c));
};

export const channelIds = (): string[] => notify().channels.map((c) => c.id);

/** Validate and store the complete channel list. A channel without an id gets one from its name. */
export function saveChannels(raw: unknown): NotifyChannel[] {
  if (!Array.isArray(raw)) throw new HttpError(400, "channels must be a list");
  if (raw.length > MAX_CHANNELS) throw new HttpError(400, `at most ${MAX_CHANNELS} channels`);
  const n = notify();
  const byId = new Map(n.channels.map((c) => [c.id, c]));
  const parsed = raw.map((r) => validChannel(r, byId.get(str((r as { id?: unknown } | null)?.id))));
  const taken = new Set<string>();
  for (const c of parsed) {
    if (c.id === null) continue;
    if (taken.has(c.id)) throw new HttpError(400, `channel ids must be unique: ${c.id}`);
    taken.add(c.id);
  }
  const channels: StoredChannel[] = parsed.map((c) => {
    if (c.id !== null) return c as StoredChannel;
    const base = c.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || c.type;
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    taken.add(id);
    return { ...c, id };
  });
  writeJson(CHANNELS_FILE, { channels });
  n.channels = channels;
  for (const id of n.status.keys()) if (!taken.has(id)) n.status.delete(id);
  return listChannels();
}

// ============================================================================ messages
interface Message {
  state: "firing" | "resolved" | "test";
  summary: string;
  detail: string;
  t: number;
  transition: AlertTransition | null;
  host: string | null;
}

function messageFor(t: AlertTransition, host: string): Message {
  const what = `${t.name} on ${host}${t.subject ? ` · ${subjectText(t.subject)}` : ""}`;
  return { state: t.state, summary: `${t.state === "firing" ? "Firing" : "Resolved"}: ${what}`, detail: t.detail, t: t.t, transition: t, host };
}

const testMessage = (): Message => ({
  state: "test", summary: "Test from llama-paddock", detail: "This channel works: alerts that fire and resolve will be sent here.",
  t: Date.now() / 1000, transition: null, host: null,
});

const iso = (t: number) => new Date(t * 1000).toISOString();
const COLORS = { firing: 0xd9614c, resolved: 0x7fb069, test: 0x6fa3c7 } as const;

/** The generic webhook's JSON, documented in docs/alerts.md: keep it backwards compatible. */
function webhookBody(m: Message) {
  const t = m.transition;
  return {
    source: "llama-paddock", version, state: m.state, summary: m.summary, detail: m.detail, time: iso(m.t),
    alert: t && {
      id: t.id, rule: t.rule, name: t.name, kind: t.kind, instance: t.instance, host: m.host, subject: t.subject,
      value: t.value, detail: t.detail, flapping: t.flapping, t: t.t,
    },
  };
}

function discordBody(m: Message) {
  return {
    username: "llama-paddock",
    // alert text comes from hosts (GPU names, error messages): never let it ping anyone
    allowed_mentions: { parse: [] },
    embeds: [{
      title: m.summary.slice(0, 256), description: m.detail.slice(0, 4000), color: COLORS[m.state], timestamp: iso(m.t),
      footer: { text: `llama-paddock ${version}${m.transition?.flapping ? " · flapping" : ""}` },
    }],
  };
}

const slackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slackBody(m: Message) {
  return {
    text: slackText(m.summary),
    attachments: [{
      color: `#${COLORS[m.state].toString(16).padStart(6, "0")}`, text: slackText(m.detail),
      footer: `llama-paddock ${version}${m.transition?.flapping ? " · flapping" : ""}`, ts: Math.floor(m.t),
    }],
  };
}

function emailBody(m: Message): Mail {
  const t = m.transition;
  const lines = [m.summary, "", m.detail, ""];
  if (t) {
    lines.push(`Rule: ${t.name}`, `Host: ${m.host} (${t.instance})`);
    if (t.subject) lines.push(`On: ${subjectText(t.subject)}`);
    lines.push(`Time: ${iso(t.t)}`);
    if (t.flapping) lines.push("Flapping: it fired repeatedly in a short time");
    lines.push("");
  }
  lines.push(`Sent by llama-paddock ${version}.`);
  return { subject: m.summary, text: lines.join("\n") };
}

// ============================================================================ sending
class DeliveryError extends Error {
  constructor(message: string, public retry: boolean, public retryAfter: number | null = null) {
    super(message);
  }
}

function fetchError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return "timed out";
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.message?.includes("redirect")) return "the URL redirects; use the address it redirects to";
    if (cause?.code) return `${cause.code}: ${cause.message ?? e.message}`;
    return cause?.message ?? e.message;
  }
  return String(e);
}

async function post(url: string, body: unknown, headers: Record<string, string>) {
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `llama-paddock/${version}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      // a redirected POST can turn into a GET elsewhere; better to say so than to lose the alert
      redirect: "error",
      cache: "no-store",
    });
  } catch (e) {
    throw new DeliveryError(fetchError(e), true);
  }
  if (r.ok) return;
  const text = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
  const after = Number(r.headers.get("retry-after"));
  // other 4xx answers mean the channel's settings are wrong: sending again won't help
  const retry = r.status === 408 || r.status === 429 || r.status >= 500;
  throw new DeliveryError(`HTTP ${r.status}${text ? `: ${text}` : ""}`, retry, Number.isFinite(after) && after > 0 ? after : null);
}

async function send(c: Omit<StoredChannel, "id">, m: Message) {
  switch (c.type) {
    case "webhook":
      return post(c.url!, webhookBody(m), c.token ? { Authorization: `Bearer ${c.token}` } : {});
    case "discord":
      return post(c.url!, discordBody(m), {});
    case "slack":
      return post(c.url!, slackBody(m), {});
    case "email":
      try {
        await sendMail(c.email!, emailBody(m));
      } catch (e) {
        throw new DeliveryError(e instanceof Error ? e.message : String(e), true);
      }
  }
}

/** Send a test message through a channel as entered in the editor, saved or not. */
export async function testChannel(raw: unknown): Promise<{ ok: boolean; detail: string }> {
  const n = notify();
  const existing = n.channels.find((c) => c.id === str((raw as { id?: unknown } | null)?.id));
  const c = validChannel(raw, existing);
  try {
    await send(c, testMessage());
    return { ok: true, detail: c.email ? `sent to ${c.email.to.join(", ")}` : "sent" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================ delivery
interface NotifyState {
  channels: StoredChannel[];
  status: Map<string, ChannelStatus>;
  /** per channel, the end of its chain of deliveries */
  queues: Map<string, Promise<void>>;
  /** the channels each firing alert went to, so that its resolved message goes to the same ones */
  routed: Map<string, string[]>;
  started: boolean;
}

// One per server process, shared by the poller and every route bundle.
const g = globalThis as unknown as { __paddockNotify?: NotifyState };

function notify(): NotifyState {
  return (g.__paddockNotify ??= { channels: readChannels(), status: new Map(), queues: new Map(), routed: new Map(), started: false });
}

function statusOf(n: NotifyState, id: string): ChannelStatus {
  let s = n.status.get(id);
  if (!s) n.status.set(id, (s = { last_ok: null, last_error: null, last_error_at: null, queued: 0 }));
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deliver(n: NotifyState, id: string, m: Message, st: ChannelStatus) {
  for (let attempt = 0; ; attempt++) {
    // read the channel again on every attempt: it may have been edited, disabled or deleted meanwhile
    const c = n.channels.find((x) => x.id === id);
    if (!c?.enabled) return;
    try {
      await send(c, m);
      st.last_ok = Date.now() / 1000;
      return;
    } catch (e) {
      const err = e instanceof DeliveryError ? e : new DeliveryError(String(e), true);
      st.last_error = err.message;
      st.last_error_at = Date.now() / 1000;
      const last = !err.retry || attempt >= RETRY_DELAYS_S.length;
      console.error(`[llama-paddock] notification to ${c.name} failed${last ? "" : ", will retry"}: ${err.message}`);
      if (last) return;
      await sleep(Math.min(MAX_RETRY_AFTER_S, err.retryAfter ?? RETRY_DELAYS_S[attempt]) * 1000);
    }
  }
}

function enqueue(n: NotifyState, id: string, m: Message) {
  const st = statusOf(n, id);
  if (st.queued >= MAX_QUEUED) {
    st.last_error = `a message wasn't sent: ${MAX_QUEUED} were already waiting`;
    st.last_error_at = Date.now() / 1000;
    return;
  }
  st.queued++;
  const next = (n.queues.get(id) ?? Promise.resolve())
    .then(() => deliver(n, id, m, st))
    .catch((e) => console.error("[llama-paddock] notification delivery failed:", e))
    .finally(() => {
      st.queued--;
      if (n.queues.get(id) === next) n.queues.delete(id);
    });
  n.queues.set(id, next);
}

/** The enabled channels a rule sends to: the ones it lists, or all of them. */
function channelsOf(n: NotifyState, ruleId: string): string[] {
  const wanted = listRules().find((r) => r.id === ruleId)?.channels ?? null;
  return n.channels.filter((c) => c.enabled && (wanted === null || wanted.includes(c.id))).map((c) => c.id);
}

function route(n: NotifyState, t: AlertTransition, host: string) {
  const key = `${t.rule}\u0000${t.instance}\u0000${t.subject}`;
  let targets: string[];
  if (t.state === "firing") {
    targets = channelsOf(n, t.rule);
    n.routed.set(key, targets);
  } else {
    // after a restart the firing's channels aren't known: fall back to the rule's (all, if it was deleted)
    targets = (n.routed.get(key) ?? channelsOf(n, t.rule)).filter((id) => n.channels.find((c) => c.id === id)?.send_resolved);
    n.routed.delete(key);
  }
  const m = messageFor(t, host);
  for (const id of targets) enqueue(n, id, m);
}

/** Start sending alert transitions to the channels. `hostName` turns a host id into the name people know it by. */
export function startNotifications(hostName: (id: string) => string) {
  const n = notify();
  if (n.started) return;
  n.started = true;
  onAlertTransition((t) => route(n, t, hostName(t.instance)));
}
