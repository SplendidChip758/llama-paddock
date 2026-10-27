import "server-only";
import fs from "node:fs";
import { parse } from "yaml";

export interface Instance {
  id: string;
  name: string;
  ollama_url: string;
  agent_url: string | null;
  agent_token: string | null;
  tags: string[];
}

export interface Settings {
  poll_interval: number;
  history_points: number;
  instances: Instance[];
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Expand ${VAR} / ${VAR:-default} so secrets can live in the container environment. */
function expand(v: unknown): unknown {
  if (typeof v === "string") return v.replace(ENV_RE, (_, name: string, def?: string) => process.env[name] ?? def ?? "");
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function loadSettings(): Settings {
  const path = process.env.PADDOCK_CONFIG || "/config/config.yaml";
  if (!fs.existsSync(/*turbopackIgnore: true*/ path)) throw new Error(`config not found: ${path} (set PADDOCK_CONFIG)`);
  const raw = (expand(parse(fs.readFileSync(/*turbopackIgnore: true*/ path, "utf8")) ?? {}) as Record<string, any>);

  const instances: Instance[] = (raw.instances ?? []).map((item: Record<string, any>, i: number) => {
    const id = String(item.id ?? `instance-${i + 1}`);
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`instance id ${id} may only contain letters, digits, _ . -`);
    if (!item.ollama_url) throw new Error(`instance ${id} needs ollama_url`);
    return {
      id,
      name: String(item.name ?? id),
      ollama_url: trimSlash(String(item.ollama_url)),
      agent_url: item.agent_url ? trimSlash(String(item.agent_url)) : null,
      agent_token: item.agent_token ? String(item.agent_token) : null,
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    };
  });
  if (new Set(instances.map((i) => i.id)).size !== instances.length) throw new Error("instance ids must be unique");

  return {
    poll_interval: Number(raw.poll_interval ?? 3),
    history_points: Number(raw.history_points ?? 400),
    instances,
  };
}
