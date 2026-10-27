import { agent, getInstance, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/logs">) => {
  const { id } = await ctx.params;
  const lines = Math.max(10, Math.min(Number(new URL(req.url).searchParams.get("lines")) || 200, 2000));
  return json(await agent(getInstance(id), "GET", `/logs?lines=${lines}`));
});
