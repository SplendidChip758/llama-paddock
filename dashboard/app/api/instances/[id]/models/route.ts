import { getInstance, handle, json, ollama } from "@/lib/server";
import { isCloudModel } from "@/lib/split";
import type { TagModel } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/models">) => {
  const { id } = await ctx.params;
  const d = await ollama<{ models?: TagModel[] }>(getInstance(id), "GET", "/api/tags");
  // flagged here so API clients don't each need to know how Ollama marks cloud models
  return json({ ...d, models: (d.models ?? []).map((m) => ({ ...m, cloud: isCloudModel(m) })) });
});
