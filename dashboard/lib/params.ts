import type { ParamValue } from "./types";
import { HttpError } from "./server";

const PARAM_TYPES: Record<string, "int" | "float" | "list"> = {
  num_ctx: "int", num_predict: "int", num_keep: "int", num_gpu: "int", num_thread: "int",
  num_batch: "int", top_k: "int", repeat_last_n: "int", seed: "int", mirostat: "int",
  temperature: "float", top_p: "float", min_p: "float", typical_p: "float",
  repeat_penalty: "float", presence_penalty: "float", frequency_penalty: "float",
  mirostat_tau: "float", mirostat_eta: "float",
  stop: "list",
};

export function coerceParam(key: string, val: unknown): ParamValue {
  const t = PARAM_TYPES[key];
  if (t === "list") return Array.isArray(val) ? val.map(String) : [String(val)];
  if (typeof val === "number" || typeof val === "boolean") {
    if (t === "int" && typeof val === "number") return Math.trunc(val);
    return val;
  }
  const s = String(val).trim();
  if (t === "int" || t === "float") {
    const n = Number(s);
    if (s === "" || Number.isNaN(n)) throw new HttpError(400, `parameter ${key} must be a number, got ${JSON.stringify(s)}`);
    return t === "int" ? Math.trunc(n) : n;
  }
  if (s === "true" || s === "false") return s === "true";
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

/** `/api/show` returns parameters as "key   value" lines; repeated keys (stop) become lists. */
export function parseParameters(text: string | null | undefined): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (let line of (text ?? "").split("\n")) {
    line = line.trim();
    if (!line) continue;
    const sp = line.search(/\s/);
    const key = sp < 0 ? line : line.slice(0, sp);
    let val = sp < 0 ? "" : line.slice(sp).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    const v = coerceParam(key, val);
    if (key === "stop" || key in out) {
      const prev = out[key];
      const prevList = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
      out[key] = [...prevList, ...(Array.isArray(v) ? v : [String(v)])];
    } else {
      out[key] = v;
    }
  }
  return out;
}

export const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/;
