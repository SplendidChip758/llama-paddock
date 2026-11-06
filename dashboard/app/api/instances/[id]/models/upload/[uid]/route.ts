import { audit } from "@/lib/audit";
import { HttpError, handle, json } from "@/lib/server";
import { CHUNK_SIZE, addChunk, cancelUpload, finishUpload } from "@/lib/uploads";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<"/api/instances/[id]/models/upload/[uid]">;

/** One chunk of the file, at ?offset=, as application/octet-stream. */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { id, uid } = await ctx.params;
  // like readBody()'s JSON rule: a type that makes browsers preflight a cross-origin request
  if (!/^application\/octet-stream\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "chunks must be application/octet-stream");
  const offset = Number(new URL(req.url).searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "offset must be a byte offset");
  const declared = Number(req.headers.get("content-length"));
  if (declared > CHUNK_SIZE) throw new HttpError(413, `chunks are at most ${CHUNK_SIZE} bytes`);
  return json(await addChunk(id, uid, offset, new Uint8Array(await req.arrayBuffer())));
});

/** Finish: hash the file, send it to Ollama → {digest, filename, size, architecture, …}. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { id, uid } = await ctx.params;
  const blob = await finishUpload(id, uid);
  audit(req, { action: "model.upload", instance: id, target: blob.filename, detail: `${blob.digest}, ${blob.size} bytes` });
  const info = blob.model_info;
  const arch = typeof info["general.architecture"] === "string" ? (info["general.architecture"] as string) : null;
  return json({
    digest: blob.digest, filename: blob.filename, size: blob.size, architecture: arch,
    name: typeof info["general.name"] === "string" ? info["general.name"] : null,
    context_length: arch ? (info[`${arch}.context_length`] ?? null) : null,
    parameter_count: info["general.parameter_count"] ?? null,
  });
});

/** Give up on an upload and delete what has arrived. */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const { id, uid } = await ctx.params;
  cancelUpload(id, uid);
  return json({ ok: true });
});
