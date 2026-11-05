import { HttpError, fixGpu, handle, json, readBody } from "@/lib/server";
import type { GpuFixAction } from "@/lib/types";
import { audit, restartOutcome } from "@/lib/audit";

export const dynamic = "force-dynamic";

const ACTIONS: GpuFixAction[] = ["restart", "reload_uvm"];

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/gpu-check/fix">) => {
  const { id } = await ctx.params;
  const { action } = await readBody<{ action?: unknown }>(req);
  if (!ACTIONS.includes(action as GpuFixAction)) throw new HttpError(400, `action must be one of ${ACTIONS.join(", ")}`);
  const r = await fixGpu(id, action as GpuFixAction);
  audit(req, { action: "ollama.gpu_fix", instance: id, target: String(action), detail: restartOutcome(r) });
  return json(r);
});
