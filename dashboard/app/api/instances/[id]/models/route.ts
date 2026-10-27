import { getInstance, handle, json, ollama } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/models">) => {
  const { id } = await ctx.params;
  return json(await ollama(getInstance(id), "GET", "/api/tags"));
});
