import "server-only";
import type { Instance } from "./config";
import { HttpError } from "./http-error";
import { coerceParam } from "./params";
import { ndjsonLines, ollamaPost } from "./server";
import type { ChatMessage, ParamValue, PromptEvent, PromptStats } from "./types";

// Test prompts (#17): stream a chat from one host and time it. Benchmarks reuse streamChat().

/** Loading a large model from a slow disk can take minutes before the first byte comes back. */
const FIRST_BYTE_TIMEOUT_MS = 600_000;

const ROLES = new Set<ChatMessage["role"]>(["system", "user", "assistant"]);

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  options?: Record<string, ParamValue>;
  keep_alive?: string | number;
  think?: boolean;
}

/** Check a chat request from the browser or a script, keeping only what Ollama's /api/chat should see. */
export function parseChatRequest(b: Record<string, unknown>): ChatRequest {
  const model = typeof b.model === "string" ? b.model.trim() : "";
  if (!model || /\s/.test(model)) throw new HttpError(400, `"model" is required`);
  if (!Array.isArray(b.messages) || !b.messages.length) throw new HttpError(400, `"messages" must be a non-empty list`);
  const messages = b.messages.map((m, i): ChatMessage => {
    const { role, content } = (m ?? {}) as Record<string, unknown>;
    if (!ROLES.has(role as ChatMessage["role"])) throw new HttpError(400, `messages[${i}].role must be system, user or assistant`);
    if (typeof content !== "string") throw new HttpError(400, `messages[${i}].content must be a string`);
    return { role: role as ChatMessage["role"], content };
  });
  const req: ChatRequest = { model, messages };
  if (b.options != null) {
    if (typeof b.options !== "object" || Array.isArray(b.options)) throw new HttpError(400, `"options" must be an object`);
    const options: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(b.options)) if (v !== null && v !== "") options[k] = coerceParam(k, v);
    req.options = options;
  }
  if (typeof b.keep_alive === "string" || typeof b.keep_alive === "number") req.keep_alive = b.keep_alive;
  if (typeof b.think === "boolean") req.think = b.think;
  return req;
}

const ms = (ns: unknown) => (typeof ns === "number" && ns >= 0 ? ns / 1e6 : null);
const count = (n: unknown) => (typeof n === "number" && n >= 0 ? n : null);
const rate = (n: number | null, t: number | null) => (n != null && t ? n / (t / 1000) : null);

/** Ollama reports durations in nanoseconds on an answer's final line. */
export function promptStats(done: Record<string, unknown>, ttftMs: number | null, wallMs: number): PromptStats {
  const prompt_tokens = count(done.prompt_eval_count), prompt_ms = ms(done.prompt_eval_duration);
  const tokens = count(done.eval_count), eval_ms = ms(done.eval_duration);
  return {
    ttft_ms: ttftMs, wall_ms: wallMs, load_ms: ms(done.load_duration),
    prompt_tokens, prompt_ms, prompt_tps: rate(prompt_tokens, prompt_ms),
    tokens, eval_ms, tps: rate(tokens, eval_ms),
    total_ms: ms(done.total_duration),
    done_reason: typeof done.done_reason === "string" ? done.done_reason : null,
  };
}

/**
 * Send a chat to a host and stream its answer. Resolves once Ollama starts answering, which is
 * after it has loaded the model, so errors such as an unknown model are thrown here rather than
 * streamed. Aborting `signal` stops the answer upstream too, so the host stops generating.
 */
export async function streamChat(inst: Instance, req: ChatRequest, signal: AbortSignal): Promise<AsyncGenerator<PromptEvent>> {
  const started = performance.now();
  const firstByte = new AbortController();
  const timer = setTimeout(() => firstByte.abort(), FIRST_BYTE_TIMEOUT_MS);
  try {
    const r = await ollamaPost(inst, "/api/chat", { ...req, stream: true }, AbortSignal.any([signal, firstByte.signal]));
    return answer(r, started, signal);
  } catch (e) {
    if (firstByte.signal.aborted) throw new HttpError(504, `ollama didn't start answering within ${FIRST_BYTE_TIMEOUT_MS / 60_000} minutes`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function* answer(r: Response, started: number, signal: AbortSignal): AsyncGenerator<PromptEvent> {
  let ttft: number | null = null;
  try {
    for await (const msg of ndjsonLines(r)) {
      if (msg.error) {
        yield { type: "error", detail: String(msg.error) };
        return;
      }
      const content = typeof msg.message?.content === "string" ? msg.message.content : "";
      const thinking = typeof msg.message?.thinking === "string" ? msg.message.thinking : "";
      if (content || thinking) {
        ttft ??= performance.now() - started;
        yield { type: "token", content, ...(thinking ? { thinking } : {}) };
      }
      if (msg.done) {
        yield { type: "done", stats: promptStats(msg, ttft, performance.now() - started) };
        return;
      }
    }
    yield { type: "error", detail: "the answer ended before Ollama finished it" };
  } catch (e) {
    if (!signal.aborted) yield { type: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}
