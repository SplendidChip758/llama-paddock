import { agent, expectedRestart, getInstance, handle, json } from "@/lib/server";
import { audit, restartOutcome } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/restart">) => {
  const { id } = await ctx.params;
  const inst = getInstance(id);
  const r = await expectedRestart(id, () => agent(inst, "POST", "/service/restart", undefined, 120_000));
  audit(req, { action: "ollama.restart", instance: id, detail: restartOutcome(r) });
  return json(r);
});
