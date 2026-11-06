import crypto from "node:crypto";
import {
  HttpError, fitHost, getInstance, getState, handle, json, listJobs, ndjsonLines, ollama, ollamaPost, paddock, readBody, startJob, startTask,
} from "@/lib/server";
import { estimateFit, fitModel } from "@/lib/fit";
import { modelSizes } from "@/lib/db";
import { isCloudModel } from "@/lib/split";
import { MODEL_NAME_RE, coerceParam, nativeContext, parseParameters } from "@/lib/params";
import { registryModel } from "@/lib/registry";
import { uploadedBlob } from "@/lib/uploads";
import type { FitModel, FitResult, ParamValue, ShowResult, TagModel } from "@/lib/types";
import type { Instance } from "@/lib/config";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/types";

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
    const result: ShowResult = {
      model,
      details: d.details ?? null,
      capabilities: d.capabilities ?? null,
      parameters: parseParameters(d.parameters),
      parameters_raw: d.parameters ?? null,
      system: d.system ?? null,
      template: d.template ?? null,
      native_context_length: nativeContext(info),
      architecture: (info["general.architecture"] as string) ?? null,
      parameter_count: (info["general.parameter_count"] as number) ?? null,
      modified_at: d.modified_at ?? null,
    };
    return result;
  },

  /** Estimate where the model fits at a context, on this host and every other one. Read-only. */
  async fit(inst, body) {
    const ctx = body.num_ctx;
    if (ctx !== undefined && ctx !== null && !(Number.isInteger(ctx) && (ctx as number) > 0)) throw new HttpError(400, '"num_ctx" must be a positive integer');
    let m: FitModel;
    let source: FitResult["source"] = "host";
    const blob = typeof body.blob === "string" ? body.blob : null;
    const model = blob && !body.model ? "uploaded model" : str(body, "model");
    const tags = blob ? null : await ollama<{ models?: TagModel[] }>(inst, "GET", "/api/tags");
    const tag = (tags?.models ?? []).find((m) => m.name === model || m.model === model || m.name === `${model}:latest`) ?? null;
    if (blob) {
      // a GGUF uploaded for a new model: its header was read when it arrived
      const up = uploadedBlob(inst.id, blob);
      if (!up) throw new HttpError(404, "no GGUF with that digest was uploaded to this host since the dashboard started");
      m = fitModel(model, { model_info: up.model_info, parameters: {} }, { size: up.size }, false);
      source = "upload";
    } else if (tag || isCloudModel({ name: model })) {
      const show = tag && !isCloudModel(tag) ? await ollama(inst, "POST", "/api/show", { model }) : {};
      m = fitModel(model, { model_info: show.model_info, parameters: parseParameters(show.parameters) }, tag, isCloudModel(tag ?? { name: model }));
    } else {
      // not pulled here: its registry has the size, and the GGUF header has the shape
      const r = await registryModel(model);
      m = fitModel(model, { model_info: r.model_info, parameters: r.parameters }, { size: r.weights + r.projector, digest: r.digest }, false);
      source = "registry";
    }
    const hosts = [inst.id, ...[...paddock().instances.keys()].filter((id) => id !== inst.id)].map((id) => fitHost(getState(id), m.digest));
    // one GPU of this host instead of all of them, as the library's fit filter can ask
    if (body.gpu !== undefined && body.gpu !== null) {
      const gpu = hosts[0].gpus?.find((x) => x.index === body.gpu);
      if (!gpu) throw new HttpError(400, `"gpu" must be the index of one of ${inst.name}'s GPUs`);
      hosts[0] = { ...hosts[0], gpus: [gpu] };
    }
    const measurements = m.digest ? modelSizes(m.digest) : [];
    const result: FitResult = { model: m, source, hosts, measurements, estimates: hosts.map((h) => estimateFit(m, h, measurements, ctx as number | null | undefined)) };
    return result;
  },

  async pull(inst, body) {
    const model = str(body, "model");
    if (/\s/.test(model)) throw new HttpError(400, "invalid model name");
    const existing = listJobs().find((j) => j.kind === "pull" && j.instance === inst.id && j.model === model && j.state === "running");
    if (existing) return existing;
    return startJob("pull", inst, model, "/api/pull", { model, stream: true });
  },

  /**
   * A model layered on `from` (installed, or with pull: true a library or hf.co model, pulled first),
   * or from `blob`, a GGUF uploaded through …/models/upload. Parameters, system prompt and template
   * override what the base has.
   */
  async create(inst, body) {
    const model = str(body, "model");
    if (!MODEL_NAME_RE.test(model)) throw new HttpError(400, `invalid model name ${JSON.stringify(model)}`);
    const blob = body.blob === undefined ? null : String(body.blob);
    if (blob !== null && !/^sha256:[0-9a-f]{64}$/.test(blob)) throw new HttpError(400, '"blob" must be a digest, sha256:<64 hex digits>');
    if (blob !== null && body.from !== undefined) throw new HttpError(400, 'give "from" or "blob", not both');
    const from = blob === null ? str(body, "from") : null;
    if (from !== null && !MODEL_NAME_RE.test(from)) throw new HttpError(400, `invalid model name ${JSON.stringify(from)}`);
    const raw = (body.parameters ?? {}) as Record<string, unknown>;
    const parameters: Record<string, ParamValue> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      parameters[k] = coerceParam(k, v);
    }
    const req: Body = { model, parameters, stream: true };
    if (from !== null) req.from = from;
    // Ollama only uses the file name to tell the files of a model apart
    else req.files = { [uploadedBlob(inst.id, blob!)?.filename ?? "model.gguf"]: blob };
    if (typeof body.system === "string") req.system = body.system;
    if (typeof body.template === "string") req.template = body.template;
    const base = from ?? `uploaded ${uploadedBlob(inst.id, blob!)?.filename ?? blob}`;
    const detail = `from ${base}: ` + Object.entries(parameters).map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`).join(", ");

    const installed = from === null || body.pull !== true || ((await ollama<{ models?: TagModel[] }>(inst, "GET", "/api/tags")).models ?? [])
      .some((m) => m.name === from || m.name === `${from}:latest`);
    if (installed) return startJob("create", inst, model, "/api/create", req, detail);

    // the base isn't on the host yet: pull it, then create, as one job
    return startTask("create", inst, model, `pull ${from}, then ${detail}`, crypto.randomBytes(6).toString("hex"), async (progress, signal) => {
      const run = async (path: string, payload: unknown, label: (status: string) => string) => {
        const r = await ollamaPost(inst, path, payload, signal);
        for await (const msg of ndjsonLines(r)) {
          if (msg.error) throw new Error(msg.error);
          progress({ ...(msg.status ? { status: label(msg.status) } : {}), ...(msg.total ? { completed: msg.completed ?? 0, total: msg.total } : {}) });
        }
      };
      await run("/api/pull", { model: from, stream: true }, (st) => `pulling ${from}: ${st}`);
      progress({ completed: 0, total: 0 });
      await run("/api/create", req, (st) => st);
    });
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

/** What each changing action records: the model it acted on, and a detail without prompts. */
const audited: Record<string, (b: Body) => { target: unknown; detail?: string }> = {
  pull: (b) => ({ target: b.model }),
  create: (b) => ({
    target: b.model,
    detail: [
      b.blob ? `from uploaded ${String(b.blob)}` : `from ${String(b.from)}${b.pull === true ? " (pulled if missing)" : ""}`,
      typeof b.template === "string" ? "template set" : "",
      Object.keys((b.parameters ?? {}) as object).length ? `parameters ${Object.keys(b.parameters as object).join(", ")}` : "",
      typeof b.system === "string" ? "system prompt set" : "",
    ].filter(Boolean).join("; "),
  }),
  copy: (b) => ({ target: b.destination, detail: `from ${String(b.source)}` }),
  delete: (b) => ({ target: b.model }),
  load: (b) => ({ target: b.model, detail: b.keep_alive !== undefined ? `keep_alive ${JSON.stringify(b.keep_alive)}` : "" }),
  unload: (b) => ({ target: b.model }),
};

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/models/[action]">) => {
  const { id, action } = await ctx.params;
  const inst = getInstance(id);
  const fn = actions[action];
  if (!fn) throw new HttpError(404, `unknown action ${action}`);
  const body = await readBody<Body>(req);
  const result = await fn(inst, body);
  const what = audited[action]?.(body);
  if (what) audit(req, { action: `model.${action}` as AuditAction, instance: id, target: String(what.target), detail: what.detail });
  return json(result);
});
