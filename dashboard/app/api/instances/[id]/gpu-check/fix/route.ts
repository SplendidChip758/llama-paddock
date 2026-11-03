import { HttpError, fixGpu, handle, json, readBody } from "@/lib/server";
import type { GpuFixAction } from "@/lib/types";

export const dynamic = "force-dynamic";

const ACTIONS: GpuFixAction[] = ["restart", "reload_uvm"];

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/gpu-check/fix">) => {
  const { id } = await ctx.params;
  const { action } = await readBody<{ action?: unknown }>(req);
  if (!ACTIONS.includes(action as GpuFixAction)) throw new HttpError(400, `action must be one of ${ACTIONS.join(", ")}`);
  return json(await fixGpu(id, action as GpuFixAction));
});
