import { checkGpu, getState, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** The GPU check as of the last poll. */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/gpu-check">) => {
  const { id } = await ctx.params;
  return json({ check: getState(id).gpuCheck() });
});

/** Read Ollama's log and settings again, and check now. */
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/gpu-check">) => {
  const { id } = await ctx.params;
  return json({ check: await checkGpu(id) });
});
