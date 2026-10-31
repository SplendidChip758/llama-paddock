import "server-only";
import fs from "node:fs";
import { parse } from "yaml";
import { readJson, writeJson } from "./store";

/** "config": defined in config.yaml (read-only in the UI). "ui": added in the dashboard, stored in the data dir. */
export type InstanceSource = "config" | "ui";

export interface Instance {
  id: string;
  name: string;
  ollama_url: string;
  /** Sent as a Bearer token on every Ollama call, for instances behind an auth proxy. */
  ollama_proxy_key: string | null;
  agent_url: string | null;
  agent_token: string | null;
  /** https:// agents: SHA256:<base64> of the agent's public key. null pins the first key the agent presents. */
  agent_fingerprint: string | null;
  /** The pin is set in config.yaml, so the dashboard can't change it. */
  agent_fingerprint_in_config: boolean;
  tags: string[];
  source: InstanceSource;
}

export interface Settings {
  poll_interval: number;
  history_points: number;
  history_retention_days: number;
  /** Bearer token for /metrics; null leaves the endpoint off unless metrics_open is set. */
  metrics_token: string | null;
  /** Serve /metrics without a token (only when no token is set). */
  metrics_open: boolean;
  instances: Instance[];
}

const HOSTS_FILE = "hosts.json";
/** Keys pinned on first use for config.yaml hosts, which the dashboard can't write back to config.yaml. */
const PINS_FILE = "agent-pins.json";
const ID_RE = /^[A-Za-z0-9_.-]+$/;
const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Expand ${VAR} / ${VAR:-default} so secrets can live in the container environment. */
function expand(v: unknown): unknown {
  if (typeof v === "string") return v.replace(ENV_RE, (_, name: string, def?: string) => process.env[name] ?? def ?? "");
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

function parseInstance(item: Record<string, any>, fallbackId: string, source: InstanceSource): Instance {
  const id = String(item.id ?? fallbackId);
  if (!ID_RE.test(id)) throw new Error(`instance id ${id} may only contain letters, digits, _ . -`);
  if (!item.ollama_url) throw new Error(`instance ${id} needs ollama_url`);
  let fingerprint: string | null;
  try {
    fingerprint = normalizeFingerprint(item.agent_fingerprint);
  } catch (e) {
    throw new Error(`instance ${id}: ${(e as Error).message}`);
  }
  return {
    id,
    name: String(item.name ?? id),
    ollama_url: trimSlash(String(item.ollama_url)),
    // ollama_api_key: the name in the 0.7.0 prereleases; hosts.json is rewritten with the new one
    ollama_proxy_key: (item.ollama_proxy_key ?? item.ollama_api_key) ? String(item.ollama_proxy_key ?? item.ollama_api_key) : null,
    agent_url: item.agent_url ? trimSlash(String(item.agent_url)) : null,
    agent_token: item.agent_token ? String(item.agent_token) : null,
    agent_fingerprint: fingerprint,
    agent_fingerprint_in_config: source === "config" && !!fingerprint,
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    source,
  };
}

function positive(v: unknown, key: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
  return n;
}

export function loadSettings(): Settings {
  const path = process.env.PADDOCK_CONFIG || "/config/config.yaml";
  // config.yaml is optional now that hosts can be added in the UI
  const raw = fs.existsSync(/*turbopackIgnore: true*/ path)
    ? ((expand(parse(fs.readFileSync(/*turbopackIgnore: true*/ path, "utf8")) ?? {}) as Record<string, any>))
    : {};

  const fromConfig = ((raw.instances ?? []) as Record<string, any>[]).map((item, i) => parseInstance(item, `instance-${i + 1}`, "config"));
  if (new Set(fromConfig.map((i) => i.id)).size !== fromConfig.length) throw new Error("instance ids must be unique");
  const learned = readJson<Record<string, LearnedPin>>(PINS_FILE) ?? {};
  for (const i of fromConfig) {
    const pin = learned[i.id];
    // a pin learned for another agent URL doesn't apply
    if (!i.agent_fingerprint && pin?.agent_url === i.agent_url) i.agent_fingerprint = pin.fingerprint;
  }

  const ids = new Set(fromConfig.map((i) => i.id));
  const fromUi: Instance[] = [];
  for (const item of readJson<{ instances?: Record<string, any>[] }>(HOSTS_FILE)?.instances ?? []) {
    const inst = parseInstance(item, "", "ui");
    if (ids.has(inst.id)) {
      console.warn(`[llama-paddock] ignoring host ${inst.id} added in the UI: config.yaml defines the same id`);
      continue;
    }
    ids.add(inst.id);
    fromUi.push(inst);
  }

  return {
    poll_interval: Number(raw.poll_interval ?? 3),
    history_points: Number(raw.history_points ?? 400),
    history_retention_days: positive(raw.history_retention_days ?? 30, "history_retention_days"),
    // `||`, not `??`: an unset ${VAR} in the YAML expands to "" and should fall through to the env
    metrics_token: String(raw.metrics_token || process.env.PADDOCK_METRICS_TOKEN || "").trim() || null,
    metrics_open: raw.metrics_open === true || raw.metrics_open === "true",
    instances: [...fromConfig, ...fromUi],
  };
}

/** Persist the hosts added in the UI. */
export function saveUiInstances(instances: Instance[]) {
  writeJson(HOSTS_FILE, {
    instances: instances.filter((i) => i.source === "ui").map(({ source: _source, agent_fingerprint_in_config: _fixed, ...rest }) => rest),
  });
}

interface LearnedPin {
  agent_url: string;
  fingerprint: string;
}

/** Persist the keys pinned for config.yaml hosts that don't set agent_fingerprint themselves. */
export function saveLearnedPins(instances: Instance[]) {
  const pins: Record<string, LearnedPin> = {};
  for (const i of instances) {
    if (i.source === "config" && !i.agent_fingerprint_in_config && i.agent_url && i.agent_fingerprint) {
      pins[i.id] = { agent_url: i.agent_url, fingerprint: i.agent_fingerprint };
    }
  }
  writeJson(PINS_FILE, pins);
}

export interface InstanceInput {
  name?: unknown;
  ollama_url?: unknown;
  /** Blank/absent keeps the stored key; `clear_ollama_proxy_key: true` removes it. */
  ollama_proxy_key?: unknown;
  /** The 0.7.0 prereleases' name for ollama_proxy_key, still accepted. */
  ollama_api_key?: unknown;
  clear_ollama_proxy_key?: unknown;
  agent_url?: unknown;
  /** Blank/absent keeps the stored token. */
  agent_token?: unknown;
  /** https:// agents: the key to pin. Absent keeps the stored one; blank pins the first key the agent presents. */
  agent_fingerprint?: unknown;
  tags?: unknown;
}

/** "192.168.1.5:11434" → "http://192.168.1.5:11434"; rejects anything that isn't http(s). */
export function normalizeUrl(value: unknown, field: string): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`${field} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${field} must start with http:// or https://`);
  return trimSlash(u.origin + u.pathname);
}

/** "SHA256:<base64>" from that form, bare base64, or hex with or without colons. Blank is null. */
export function normalizeFingerprint(value: unknown): string | null {
  const s = String(value ?? "").trim().replace(/^sha256:/i, "");
  if (!s) return null;
  const hex = /^[0-9a-f]{64}$/i.test(s) || /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(s);
  const bytes = Buffer.from(hex ? s.replace(/:/g, "") : s, hex ? "hex" : "base64");
  const b64 = bytes.toString("base64").replace(/=+$/, "");
  // Buffer.from(…, "base64") skips characters it doesn't know, so check that it read all of them
  if (bytes.length !== 32 || (!hex && b64 !== s.replace(/=+$/, ""))) {
    throw new Error("the agent fingerprint must look like SHA256:… as the agent installer prints it");
  }
  return `SHA256:${b64}`;
}

export function normalizeTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
}

/** A URL-safe id derived from the name, unique among `taken`. */
export function makeId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "host";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
