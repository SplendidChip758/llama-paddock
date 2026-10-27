import { HttpError, getInstance, handle, json, listJobs, ollama, readBody, startJob } from "@/lib/server";
import { MODEL_NAME_RE, coerceParam, parseParameters } from "@/lib/params";
import type { ParamValue, ShowResult } from "@/lib/types";
import type { Instance } from "@/lib/config";

export const dynamic = "force-dynamic";

type Body = Record<string, unknown>;

function str(b: Body, key: string): string {
  const v = b[key];
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `"${key}" is required`);
  return v.trim();
}

const actions: Record<string, (inst: Instance, body: Body) => Promise<unknown>> = {
  async show(inst, body) {
    const model = str(body, "model");
    const d = await ollama(inst, "POST", "/api/show", { model });
    const info: Record<string, unknown> = d.model_info ?? {};
    const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
    const result: ShowResult = {
      model,
      details: d.details ?? null,
      capabilities: d.capabilities ?? null,
      parameters: parseParameters(d.parameters),
      parameters_raw: d.parameters ?? null,
      system: d.system ?? null,
      template: d.template ?? null,
      native_context_length: ctxKey ? Number(info[ctxKey]) : null,
      architecture: (info["general.architecture"] as string) ?? null,
      parameter_count: (info["general.parameter_count"] as number) ?? null,
      modified_at: d.modified_at ?? null,
    };
    return result;
  },

  async pull(inst, body) {
    const model = str(body, "model");
    if (/\s/.test(model)) throw new HttpError(400, "invalid model name");
    const existing = listJobs().find((j) => j.kind === "pull" && j.instance === inst.id && j.model === model && j.state === "running");
    if (existing) return existing;
    return startJob("pull", inst, model, "/api/pull", { model, stream: true });
  },

  async create(inst, body) {
    const model = str(body, "model");
    const from = str(body, "from");
    if (!MODEL_NAME_RE.test(model)) throw new HttpError(400, `invalid model name ${JSON.stringify(model)}`);
    const raw = (body.parameters ?? {}) as Record<string, unknown>;
    const parameters: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      parameters[k] = coerceParam(k, v);
    }
    const req: Body = { model, from, parameters, stream: true };
    if (typeof body.system === "string") req.system = body.system;
    const detail = `from ${from}: ` + Object.entries(parameters).map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`).join(", ");
    return startJob("create", inst, model, "/api/create", req, detail);
  },

  async delete(inst, body) {
    await ollama(inst, "DELETE", "/api/delete", { model: str(body, "model") });
    return { ok: true };
  },

  async copy(inst, body) {
    const destination = str(body, "destination");
    if (!MODEL_NAME_RE.test(destination)) throw new HttpError(400, `invalid model name ${JSON.stringify(destination)}`);
    await ollama(inst, "POST", "/api/copy", { source: str(body, "source"), destination });
    return { ok: true };
  },

  async load(inst, body) {
    const req: Body = { model: str(body, "model"), stream: false };
    if (body.keep_alive !== undefined) req.keep_alive = body.keep_alive;
    await ollama(inst, "POST", "/api/generate", req, 600_000);
    return { ok: true };
  },

  async unload(inst, body) {
    await ollama(inst, "POST", "/api/generate", { model: str(body, "model"), keep_alive: 0, stream: false });
    return { ok: true };
  },
};

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/models/[action]">) => {
  const { id, action } = await ctx.params;
  const inst = getInstance(id);
  const fn = actions[action];
  if (!fn) throw new HttpError(404, `unknown action ${action}`);
  return json(await fn(inst, await readBody<Body>(req)));
});
