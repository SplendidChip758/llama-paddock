import { handle, json, startAgentUpdate } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/agent-update">) => {
  const { id } = await ctx.params;
  const run = await startAgentUpdate(id);
  audit(req, { action: "host.agent_update", instance: id, detail: `started from ${run.from ?? "an unknown version"}` });
  return json(run);
});
