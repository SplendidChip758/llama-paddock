import { handle, json, startAgentUpdates } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Update every outdated agent the dashboard can update. */
export const POST = handle(async (req: Request) => {
  const r = await startAgentUpdates();
  for (const id of r.started) audit(req, { action: "host.agent_update", instance: id, detail: "started with Update all" });
  return json(r);
});
