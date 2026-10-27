import { agent, getInstance, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/restart">) => {
  const { id } = await ctx.params;
  return json(await agent(getInstance(id), "POST", "/service/restart", undefined, 120_000));
});
