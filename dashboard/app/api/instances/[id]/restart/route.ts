import { agent, expectedRestart, getInstance, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/restart">) => {
  const { id } = await ctx.params;
  const inst = getInstance(id);
  return json(await expectedRestart(id, () => agent(inst, "POST", "/service/restart", undefined, 120_000)));
});
