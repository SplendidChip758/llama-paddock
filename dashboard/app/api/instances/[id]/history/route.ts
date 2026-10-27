import { getState, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/history">) => {
  const { id } = await ctx.params;
  return json({ points: getState(id).history });
});
