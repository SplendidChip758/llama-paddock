import { HttpError, getState, handle, json, readBody } from "@/lib/server";
import { startUpload } from "@/lib/uploads";

export const dynamic = "force-dynamic";

/** Start uploading a GGUF file for a new model: {filename, size} → {id, chunk_size}. Then PUT the chunks to …/upload/{id}. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/models/upload">) => {
  const { id } = await ctx.params;
  if (!getState(id).ollama_ok) throw new HttpError(502, "Ollama isn't reachable on this host");
  const body = await readBody(req);
  return json(startUpload(id, body.filename, body.size));
});
