// ===== Ollama model library (#30)
// Ollama has no search API, so this reads ollama.com's search and tags pages, the same HTML a
// browser gets. Parsing goes by what the text says (a size, a capability, "N tags") rather than by
// CSS classes, which change more often. When the page changes beyond that, the parsers return
// nothing and the API says so: pulling by name keeps working.
import "server-only";
import { version } from "@/package.json";
import { libraryEnabled } from "./registry";
import { HttpError, paddock } from "./server";
import type { LibraryModel, LibrarySearch, LibraryTag } from "./types";

const SEARCH_TTL_MS = 10 * 60_000;
const MODEL_TTL_MS = 60 * 60_000;
const CACHE_MAX = 300;
export const CAPABILITIES = ["tools", "vision", "thinking", "embedding", "audio", "cloud"] as const;

const g = globalThis as unknown as { __paddockLibrary?: Map<string, { at: number; value: Promise<unknown> }> };
const cache = (g.__paddockLibrary ??= new Map());

function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = load();
  value.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) {
    for (const [k, v] of cache) if (Date.now() - v.at >= ttl || cache.size > CACHE_MAX) cache.delete(k);
  }
  return value;
}

async function page(path: string): Promise<string> {
  if (!libraryEnabled()) throw new HttpError(404, "the model library is turned off (model_library: false)");
  const base = paddock().settings.model_library_url;
  let r: Response;
  try {
    r = await fetch(base + path, { headers: { "User-Agent": `llama-paddock/${version}`, Accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    const err = e as Error;
    throw new HttpError(502, `can't reach ${new URL(base).host}: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
  }
  if (r.status === 404) throw new HttpError(404, "not found in the Ollama library");
  if (!r.ok) throw new HttpError(502, `${new URL(base).host} answered ${r.status}`);
  return r.text();
}

// ============================================================================ parsing
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});
const text = (html: string) => decode(html.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
/** Texts of the innermost spans, where the site puts chips and counts. */
const spans = (html: string) => [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => decode(m[1]).trim()).filter(Boolean);

// lowercase only: the site writes sizes as "8b" or "135m", and download counts as "5.9M"
const SIZE_RE = /^(\d+(\.\d+)?[kmbt]|e\d+(\.\d+)?b|\d+x\d+(\.\d+)?b)$/;
const isCapability = (s: string) => (CAPABILITIES as readonly string[]).includes(s.toLowerCase());

/** "5.9M" → 5_900_000 */
function count(s: string | undefined): number | null {
  const m = /^([\d.,]+)\s*([KMB])?$/i.exec((s ?? "").trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase()] ?? 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** "5.2GB" → bytes, as the site rounds them (GB = 10^9 there) */
function bytes(s: string): number | null {
  const m = /^([\d.]+)\s*([KMGT]?B)$/i.exec(s.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()] ?? 1));
}

/** "128K" → 131072, "1M" → 1048576, "8192" → 8192 */
function tokens(s: string): number | null {
  const m = /^([\d.]+)\s*([KM])?$/i.exec(s.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ K: 1024, M: 1024 * 1024 }[(m[2] ?? "").toUpperCase()] ?? 1));
}

/** The model's path on the site: library/qwen3 for official models, user/model for others. */
const pathName = (href: string) => href.replace(/^\/+/, "").replace(/\/tags$/, "");
/** The name to pull: qwen3 for official models, user/model for others. */
const pullName = (path: string) => path.replace(/^library\//, "");

export function parseSearch(html: string): LibrarySearch {
  const models: LibraryModel[] = [];
  for (const li of html.split(/<li\b/i).slice(1)) {
    const href = /<a\s[^>]*href="(\/[^"#?]+)"/i.exec(li)?.[1];
    if (!href || !/^\/(library\/[^/]+|[^/]+\/[^/]+)$/.test(href)) continue;
    const path = pathName(href);
    const all = spans(li);
    const desc = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(li)?.[1];
    const updatedTitle = /title="Updated ([^"]+)"/i.exec(li)?.[1];
    const pulls = /title="([\d,]+) (?:downloads|pulls)"/i.exec(li)?.[1];
    const tagCount = /(\d+)\s+tags?\b/i.exec(text(li))?.[1];
    models.push({
      name: pullName(path),
      path,
      description: desc ? text(desc) : null,
      capabilities: [...new Set(all.filter(isCapability).map((s) => s.toLowerCase()))],
      sizes: [...new Set(all.filter((s) => SIZE_RE.test(s)))],
      pulls: pulls ? Number(pulls.replace(/,/g, "")) : null,
      tag_count: tagCount ? Number(tagCount) : null,
      updated: updatedTitle ? decode(updatedTitle) : null,
    });
  }
  const more = /data-has-more="(true|false)"/i.exec(html)?.[1];
  return { models, has_more: more ? more === "true" : models.length >= 20 };
}

/** Quantization from a tag name: 8b-instruct-q4_K_M → q4_K_M */
export function tagQuant(tag: string): string | null {
  return /(?:^|[-_])((?:iq|q)\d(?:_[a-z0-9]+)*|fp16|bf16|f16|fp32|f32|mxfp4|fp8)$/i.exec(tag)?.[1] ?? null;
}

export function parseTags(html: string, path: string): LibraryModel & { tags: LibraryTag[] } {
  const name = pullName(path);
  const tags: LibraryTag[] = [];
  const seen = new Set<string>();
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // each tag has a compact row (for phones) that says everything in one line:
  // "qwen3:8b latest 500a1f067a9f • 5.2GB • 40K context window • Text input • 1 year ago"
  for (const m of html.matchAll(new RegExp(`<a[^>]*href="/${esc}:([^"]+)"[^>]*>([\\s\\S]*?)</a>`, "gi"))) {
    const tag = decode(m[1]);
    const t = text(m[2]);
    const row = /\b([0-9a-f]{12})\b\s*•\s*(.*)$/i.exec(t);
    if (!row || seen.has(tag)) continue;
    seen.add(tag);
    const parts = row[2].split("•").map((s) => s.trim());
    const ctx = /([\d.]+\s*[KM]?)\s+context/i.exec(row[2])?.[1];
    const input = /([A-Za-z][A-Za-z, ]*?)\s+input\b/i.exec(row[2])?.[1];
    const when = parts.find((p) => /\bago\b|\b(19|20)\d\d\b/.test(p))?.replace(/\s+[A-Z][a-z]+(, [A-Z][a-z]+)* input.*$/, "");
    const size = parts.map(bytes).find((b) => b !== null) ?? null;
    tags.push({
      name: `${name}:${tag}`,
      tag,
      digest: row[1].toLowerCase(),
      size,
      context: ctx ? tokens(ctx) : null,
      input: input ? input.split(/,\s*|\s+and\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean) : [],
      quantization: tagQuant(tag),
      cloud: /(^|[-:])cloud$/i.test(tag) || size === null && /usage/i.test(row[2]),
      updated: when ?? null,
    });
  }
  // "latest" and other aliases name no quantization: take it from a tag with the same digest
  for (const t of tags) {
    if (!t.quantization) t.quantization = tags.find((x) => x.digest === t.digest && x.quantization)?.quantization ?? null;
  }
  const summary = /id="summary-content"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? /<meta name="description" content="([^"]*)"/i.exec(html)?.[1];
  const all = spans(html.split(/<section\b/i)[0]);
  const pulls = /<span[^>]*>([\d.,]+[KMB]?)<\/span>\s*<span[^>]*>(?:&nbsp;|\s)*(?:Downloads|Pulls)/i.exec(html)?.[1];
  const updated = /title="([A-Z][a-z]{2} \d{1,2}, \d{4}[^"]*)"/.exec(html)?.[1];
  return {
    name, path,
    description: summary ? text(summary) || null : null,
    capabilities: [...new Set(all.filter(isCapability).map((s) => s.toLowerCase()))],
    sizes: [...new Set(all.filter((s) => SIZE_RE.test(s)))],
    pulls: count(pulls),
    tag_count: tags.length,
    updated: updated ?? null,
    tags,
  };
}

// ============================================================================ API
export interface SearchQuery {
  q: string;
  capability: string | null;
  sort: "popular" | "newest";
  page: number;
}

export function searchLibrary(query: SearchQuery): Promise<LibrarySearch> {
  const p = new URLSearchParams();
  if (query.q) p.set("q", query.q);
  if (query.capability) p.set("c", query.capability);
  if (query.sort === "newest") p.set("o", "newest");
  if (query.page > 1) p.set("p", String(query.page));
  return cached(`search?${p}`, SEARCH_TTL_MS, async () => {
    const html = await page(`/search?${p}`);
    const r = parseSearch(html);
    // a page with results in it that parse to nothing: the site has changed
    if (!r.models.length && /href="\/library\//.test(html)) throw new HttpError(502, "couldn't read ollama.com's search results; the page may have changed. Pulling by name still works.");
    return r;
  });
}

/** A model's page with every tag. `path`: library/qwen3, or user/model. */
export function libraryTags(path: string): Promise<LibraryModel & { tags: LibraryTag[] }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) throw new HttpError(400, "model must be library/<name> or <user>/<name>");
  return cached(`tags:${path}`, MODEL_TTL_MS, async () => {
    const html = await page(`/${path}/tags`);
    const r = parseTags(html, path);
    if (!r.tags.length) throw new HttpError(502, `couldn't read the tags of ${pullName(path)} from ollama.com; the page may have changed. Pulling by name still works.`);
    return r;
  });
}
