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
  agent_url: string | null;
  agent_token: string | null;
  tags: string[];
  source: InstanceSource;
}

export interface Settings {
  poll_interval: number;
  history_points: number;
  history_retention_days: number;
  instances: Instance[];
}

const HOSTS_FILE = "hosts.json";
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
  return {
    id,
    name: String(item.name ?? id),
    ollama_url: trimSlash(String(item.ollama_url)),
    agent_url: item.agent_url ? trimSlash(String(item.agent_url)) : null,
    agent_token: item.agent_token ? String(item.agent_token) : null,
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
    instances: [...fromConfig, ...fromUi],
  };
}

/** Persist the hosts added in the UI. */
export function saveUiInstances(instances: Instance[]) {
  writeJson(HOSTS_FILE, { instances: instances.filter((i) => i.source === "ui").map(({ source: _source, ...rest }) => rest) });
}

export interface InstanceInput {
  name?: unknown;
  ollama_url?: unknown;
  agent_url?: unknown;
  /** Blank/absent keeps the stored token. */
  agent_token?: unknown;
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
