// ===== Context and reload warnings
// Two problems look like a bad model rather than a broken setup. Clients choose the context size:
// one that sends num_ctx 2048 overrides the host's OLLAMA_CONTEXT_LENGTH, and Ollama drops the start
// of longer prompts without an error. And when clients send different num_ctx values, or a short
// keep_alive, Ollama loads the model again and again, so requests wait for loads and VRAM churns.
// Neither is proof on its own (a client may want a small context), so the wording says "probably".
import "server-only";
import type { ContextCheck, HostEvent, PsModel, ReloadChurn } from "./types";

/** What /api/show says about a model, read once per digest. */
export interface ModelInfo {
  /** the context it was trained for */
  max: number | null;
  /** num_ctx in its Modelfile */
  num_ctx: number | null;
}

/** With nothing configured, a context this small is most likely Ollama's default (2048 or 4096, by version). */
const DEFAULT_CTX_MAX = 8192;

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The context a loaded model runs with against what the host sets. `env` is Ollama's environment,
 * or null when it isn't known (no agent): then only the Modelfile counts. undefined until /api/show
 * has been read.
 */
export function contextCheck(m: PsModel, info: ModelInfo | undefined, env: Record<string, string> | null): ContextCheck | undefined {
  if (!info) return undefined;
  const running = typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : null;
  const envCtx = Number(env?.OLLAMA_CONTEXT_LENGTH);
  const configured = info.num_ctx ?? (envCtx > 0 ? envCtx : null);
  const configured_by = info.num_ctx ? "modelfile" : configured ? "env" : null;
  const base = { running, max: info.max, configured, configured_by } as const;
  if (running === null) return { ...base, state: "unknown", hint: "This Ollama version doesn't report the context a loaded model runs with." };

  // Ollama caps the context at what the model supports
  const target = configured !== null && info.max ? Math.min(configured, info.max) : configured;
  if (target !== null && running < target) {
    const by = configured_by === "modelfile" ? `num_ctx ${fmt(configured!)} in its Modelfile` : `OLLAMA_CONTEXT_LENGTH=${configured}`;
    return {
      ...base, state: "short",
      hint: `${m.name} runs with ${fmt(running)} tokens of context, less than the ${fmt(target)} the host sets (${by}). ` +
        `A client probably asked for num_ctx ${fmt(running)}, so prompts longer than that lose their start without an error. ` +
        "Raise num_ctx in the client's settings or request options, or leave it out so the host's value applies.",
    };
  }
  if (target === null && env !== null && info.max && running < info.max && running <= DEFAULT_CTX_MAX) {
    return {
      ...base, state: "default",
      hint: `${m.name} runs with ${fmt(running)} tokens of context out of the ${fmt(info.max)} it supports, and nothing on the host sets more. ` +
        "Prompts longer than that lose their start without an error. If clients send long prompts, set OLLAMA_CONTEXT_LENGTH on the " +
        "Environment tab or num_ctx in the Modelfile. A larger context takes more VRAM.",
    };
  }
  return { ...base, state: "ok", hint: null };
}

// ============================================================================ reloads
export const RELOAD_WINDOW_S = 3600;
/** More loads than this in RELOAD_WINDOW_S count as constant reloading on the host page; alert rules set their own. */
export const RELOAD_WARN_LOADS = 10;

export interface LoadStats {
  model: string;
  /** loads the polls saw in the window, not counting the models found loaded after a restart or a gap */
  loads: number;
  /** the context sizes it was loaded with in the window */
  contexts: number[];
  /** times it was unloaded in the same poll as another model loaded */
  evicted: number;
}

/** Per model, from the load and unload events of the window ending at `now`, in time order. `models`: every model to report, loads or not. */
export function loadStats(events: HostEvent[], models: Iterable<string>, now: number): LoadStats[] {
  const since = now - RELOAD_WINDOW_S;
  const recent = events.filter((e) => e.t >= since && e.t <= now && e.model);
  const by = new Map<string, LoadStats>();
  const get = (model: string) => {
    let s = by.get(model);
    if (!s) by.set(model, (s = { model, loads: 0, contexts: [], evicted: 0 }));
    return s;
  };
  for (const m of models) get(m);
  const loadedAt = new Map<number, string[]>();
  for (const e of recent) if (e.kind === "load") loadedAt.set(e.t, [...(loadedAt.get(e.t) ?? []), e.model!]);
  for (const e of recent) {
    const s = get(e.model!);
    if (e.kind === "load") {
      if (!e.first) s.loads++;
      if (e.context_length && !s.contexts.includes(e.context_length)) s.contexts.push(e.context_length);
    } else if (e.kind === "unload" && loadedAt.get(e.t)?.some((x) => x !== e.model)) s.evicted++;
  }
  return [...by.values()];
}

/**
 * Loads Ollama's log shows that no poll saw, in the window ending at `logT`: models that loaded and
 * unloaded between polls. null without the log.
 */
export function unseenLoads(starts: number[] | null, events: HostEvent[], logT: number): number | null {
  if (!starts) return null;
  const since = logT - RELOAD_WINDOW_S;
  const logged = starts.filter((t) => t >= since && t <= logT).length;
  // a model found loaded after a restart was loaded by then too, so every load event counts here
  const seen = events.filter((e) => e.kind === "load" && e.t >= since && e.t <= logT).length;
  return Math.max(0, logged - seen);
}

/**
 * The models loaded more than `threshold` times in the window, with likely causes. `complete`: the
 * agent's log was read, so loads between polls are counted too; otherwise the counts are a minimum.
 */
export function reloadChurn(
  stats: LoadStats[], unseen: number | null, env: Record<string, string> | null, threshold = RELOAD_WARN_LOADS,
): ReloadChurn[] {
  const keepAlive = env?.OLLAMA_KEEP_ALIVE;
  const keepAliveCause = "It unloads between requests: " +
    (keepAlive ? `OLLAMA_KEEP_ALIVE is ${keepAlive}` : "Ollama unloads a model after 5 idle minutes unless OLLAMA_KEEP_ALIVE says otherwise") +
    ", and a client can ask for less with keep_alive (0 unloads it at once).";
  const keepAliveFix = "Raise OLLAMA_KEEP_ALIVE on the Environment tab (30m, or -1 to keep models loaded), and check the keep_alive clients send.";
  const atLeast = unseen === null ? "at least " : "";
  const out: ReloadChurn[] = [];
  for (const s of stats) {
    if (s.loads <= threshold) continue;
    const causes: string[] = [], fixes: string[] = [];
    if (s.contexts.length > 1) {
      causes.push(`Clients ask for different context sizes (${s.contexts.map(fmt).join(", ")}), and each change loads the model again.`);
      fixes.push("Make clients send the same num_ctx, or none, so the host's OLLAMA_CONTEXT_LENGTH or the Modelfile's num_ctx applies.");
    }
    if (s.evicted) {
      causes.push(`Loading other models pushed it out of VRAM ${s.evicted} time${s.evicted === 1 ? "" : "s"}: they don't fit together.`);
      fixes.push("Use smaller models, quantizations or contexts so they fit together, or serve them from different hosts. OLLAMA_MAX_LOADED_MODELS limits how many stay loaded.");
    }
    // loads that context changes and evictions don't account for
    if (s.loads > s.evicted + Math.max(0, s.contexts.length - 1)) {
      causes.push(keepAliveCause);
      fixes.push(keepAliveFix);
    }
    out.push({ model: s.model, loads: s.loads, summary: `${s.model} was loaded ${atLeast}${s.loads} times in the last hour.`, causes, fixes });
  }
  if (unseen !== null && unseen > threshold) {
    out.push({
      model: null, loads: unseen,
      summary: `Ollama's log shows ${unseen} model loads in the last hour that no poll saw: models loaded and unloaded between polls.`,
      causes: ["A client sends keep_alive 0 or a very short keep_alive, so its model unloads right after each request."],
      fixes: [keepAliveFix],
    });
  }
  return out;
}
