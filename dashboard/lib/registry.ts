// ===== Model registries
// Models that aren't pulled yet: their manifest in the Ollama registry (or Hugging Face's, for
// hf.co/ names) gives the exact size of each layer, and the start of the weights blob gives the
// GGUF metadata the fit estimate needs. Results are cached: manifests for an hour, metadata by
// digest for as long as the dashboard runs.
import "server-only";
import crypto from "node:crypto";
import { version } from "@/package.json";
import { ggufModelInfo, readGguf } from "./gguf";
import { HttpError, paddock } from "./server";

export interface ModelRef {
  /** https://registry.ollama.ai, https://hf.co, … */
  registry: string;
  /** library/qwen3, someone/model, bartowski/Llama-3.2-1B-Instruct-GGUF */
  repo: string;
  tag: string;
}

export interface RegistryModel {
  name: string;
  ref: ModelRef;
  /** the manifest's digest, bare hex: what Ollama reports as the model's digest once it's pulled */
  digest: string;
  /** digest of the weights layer */
  weights_digest: string;
  weights: number;
  /** a vision projector layer; 0 without one */
  projector: number;
  /** every layer: weights, projector, template, params, license… */
  total: number;
  /** from the config blob: "8.2B", "Q4_K_M", "qwen3" */
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  /** the Modelfile parameters layer, when it has any */
  parameters: Record<string, unknown> | null;
  /** GGUF metadata as /api/show's model_info; null when it couldn't be read */
  model_info: Record<string, unknown> | null;
  model_info_error: string | null;
}

const MANIFEST_TTL_MS = 3600_000;
const META_CACHE_MAX = 500;
const UA = `llama-paddock/${version}`;
const MANIFEST_TYPES = "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json";

// survives route bundles and dev reloads, like the rest of the process state
const g = globalThis as unknown as {
  __paddockRegistry?: {
    manifests: Map<string, { at: number; value: Promise<RegistryModel> }>;
    meta: Map<string, Promise<Record<string, unknown>>>;
    /** metadata by model and size (registry/repo:8b), shared by that size's quantizations */
    sizes: Map<string, Promise<Record<string, unknown>>>;
  };
};
const cache = (g.__paddockRegistry ??= { manifests: new Map(), meta: new Map(), sizes: new Map() });

/** Whether the dashboard may contact registries and ollama.com. */
export function libraryEnabled(): boolean {
  return paddock().settings.model_library;
}

/**
 * Where a model name points, the way Ollama resolves it: `qwen3` is `library/qwen3:latest` on the
 * Ollama registry, `user/model` a user's model there, and a first part with a dot a registry host
 * (`hf.co/user/repo:Q4_K_M`).
 */
export function parseRef(name: string, registry = paddock().settings.model_registry_url): ModelRef {
  let rest = name.trim();
  let tag = "latest";
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1) || "latest";
    rest = rest.slice(0, colon);
  }
  const parts = rest.split("/").filter(Boolean);
  if (!parts.length) throw new HttpError(400, "model name is empty");
  if (parts.length > 1 && /[.:]/.test(parts[0])) {
    const host = parts.shift()!.toLowerCase();
    const configured = new URL(registry);
    // Ollama pulls hf.co names through Hugging Face's registry
    const base = host === "hf.co" || host === "huggingface.co"
      ? "https://hf.co"
      : host === configured.host.toLowerCase() ? registry : null;
    if (!base) throw new HttpError(400, `registry host ${host} isn't allowed`);
    return { registry: base, repo: parts.join("/"), tag };
  }
  return { registry, repo: parts.length === 1 ? `library/${parts[0]}` : parts.join("/"), tag };
}

async function get(url: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  try {
    const configured = new URL(paddock().settings.model_registry_url);
    const allowedHosts = new Set([configured.host.toLowerCase(), "hf.co", "huggingface.co"]);
    const headers = { "User-Agent": UA, ...(init.headers as Record<string, string>) };
    const signal = AbortSignal.timeout(init.timeout ?? 15_000);
    let current = new URL(url);
    for (let redirects = 0; ; redirects++) {
      const response = await fetch(current, { ...init, redirect: "manual", headers, signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, current);
      if (
        redirects >= 5 ||
        !allowedHosts.has(next.host.toLowerCase()) ||
        (next.protocol !== "https:" && next.origin !== configured.origin) ||
        next.username || next.password
      ) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(502, "registry redirect target isn't allowed");
      }
      await response.body?.cancel().catch(() => {});
      current = next;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const err = e as Error;
    throw new HttpError(502, `can't reach ${new URL(url).host}: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
  }
}

/** Read `length` bytes from `offset` of a blob. A registry that ignores Range is cut off after `length` bytes. */
async function readBlob(ref: ModelRef, digest: string, offset: number, length: number): Promise<Uint8Array> {
  const r = await get(`${ref.registry}/v2/${ref.repo}/blobs/${digest}`, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` }, timeout: 60_000,
  });
  if (r.status === 416) return new Uint8Array(0);
  if (!r.ok || !r.body) throw new HttpError(502, `${new URL(r.url).host} answered ${r.status} for the model's weights`);
  let skip = r.status === 206 ? 0 : offset;
  const out = new Uint8Array(length);
  let n = 0;
  const reader = r.body.getReader();
  try {
    while (n < length) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (skip) {
        const s = Math.min(skip, chunk.byteLength);
        chunk = chunk.subarray(s);
        skip -= s;
      }
      const take = Math.min(chunk.byteLength, length - n);
      out.set(chunk.subarray(0, take), n);
      n += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, n);
}

interface Manifest {
  config?: { digest: string };
  layers?: { mediaType: string; digest: string; size: number }[];
}

async function loadModel(name: string, ref: ModelRef): Promise<RegistryModel> {
  const r = await get(`${ref.registry}/v2/${ref.repo}/manifests/${ref.tag}`, { headers: { Accept: MANIFEST_TYPES } });
  if (r.status === 404 || r.status === 401) throw new HttpError(404, `${name} isn't in the registry (${new URL(ref.registry).host})`);
  if (!r.ok) throw new HttpError(502, `${new URL(ref.registry).host} answered ${r.status} for ${name}`);
  const body = Buffer.from(await r.arrayBuffer());
  const m = JSON.parse(body.toString("utf8")) as Manifest;
  // Ollama names a model by the sha256 of its manifest; registries may say it in a header instead
  const digest = /^sha256:([0-9a-f]{64})$/.exec(r.headers.get("docker-content-digest") ?? "")?.[1] ?? crypto.createHash("sha256").update(body).digest("hex");
  const layers = m.layers ?? [];
  const weights = layers.find((l) => l.mediaType === "application/vnd.ollama.image.model");
  if (!weights) throw new HttpError(404, `${name} has no model weights in the registry`);
  const projector = layers.filter((l) => l.mediaType === "application/vnd.ollama.image.projector").reduce((a, l) => a + l.size, 0);

  const blobJson = async (digest: string | undefined) => {
    if (!digest) return null;
    try {
      const b = await get(`${ref.registry}/v2/${ref.repo}/blobs/${digest}`);
      return b.ok ? ((await b.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const params = layers.find((l) => l.mediaType === "application/vnd.ollama.image.params");
  const [config, parameters] = await Promise.all([blobJson(m.config?.digest), params && params.size < 65536 ? blobJson(params.digest) : null]);

  let model_info: Record<string, unknown> | null = null;
  let model_info_error: string | null = null;
  try {
    model_info = await ggufInfo(ref, weights.digest, sizeKey(ref));
  } catch (e) {
    model_info_error = (e as Error).message;
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    name, ref, digest, weights_digest: weights.digest, weights: weights.size, projector,
    total: layers.reduce((a, l) => a + l.size, 0),
    parameter_size: str(config?.model_type), quantization: str(config?.file_type), family: str(config?.model_family),
    parameters, model_info, model_info_error,
  };
}

/**
 * The model and parameter size a tag names (registry/library/qwen3:8b for 8b-q8_0 and 8b-instruct-fp16):
 * quantizing changes the weights, not the layers, heads or context, so one header serves them all.
 * null for tags without a size, such as latest.
 */
function sizeKey(ref: ModelRef): string | null {
  const size = /^(e?\d+(?:\.\d+)?[mbt]|\d+x\d+(?:\.\d+)?b)(?=$|[-_])/i.exec(ref.tag)?.[1];
  return size ? `${ref.registry}/${ref.repo}:${size.toLowerCase()}` : null;
}

function ggufInfo(ref: ModelRef, digest: string, size: string | null): Promise<Record<string, unknown>> {
  let p = cache.meta.get(digest) ?? (size ? cache.sizes.get(size) : undefined);
  if (!p) {
    // the vocabulary makes this a few MB per read: a library model's tags would add up to hundreds
    p = readGguf((offset, length) => readBlob(ref, digest, offset, length)).then(ggufModelInfo);
    p.catch(() => {
      cache.meta.delete(digest);
      if (size) cache.sizes.delete(size);
    });
    if (size) cache.sizes.set(size, p);
    if (cache.sizes.size > META_CACHE_MAX) cache.sizes.delete(cache.sizes.keys().next().value!);
  }
  cache.meta.set(digest, p);
  if (cache.meta.size > META_CACHE_MAX) cache.meta.delete(cache.meta.keys().next().value!);
  return p;
}

/** A model's manifest and metadata from its registry. Throws 404 when the registry doesn't have it. */
export function registryModel(name: string): Promise<RegistryModel> {
  if (!libraryEnabled()) throw new HttpError(404, `${name} isn't installed on this host, and model_library is off, so the registry isn't asked`);
  const ref = parseRef(name);
  const key = `${ref.registry}/${ref.repo}:${ref.tag}`;
  const hit = cache.manifests.get(key);
  if (hit && Date.now() - hit.at < MANIFEST_TTL_MS) return hit.value;
  const value = loadModel(name, ref);
  value.catch(() => cache.manifests.delete(key));
  cache.manifests.set(key, { at: Date.now(), value });
  for (const [k, v] of cache.manifests) if (Date.now() - v.at >= MANIFEST_TTL_MS) cache.manifests.delete(k);
  return value;
}

/** "8.2B" → 8.2e9, "567M" → 5.67e8. */
export function parseParamSize(s: string | null | undefined): number | null {
  const m = /^([\d.]+)\s*([KMBT])?/i.exec(s ?? "");
  if (!m) return null;
  const n = Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] ?? "").toUpperCase()] ?? 1);
  return Number.isFinite(n) && n > 0 ? n : null;
}
