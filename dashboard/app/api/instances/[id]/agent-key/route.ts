import { acceptAgentKey, getInstance, handle, json, readBody } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Pin a new key for an https:// agent, e.g. the one it presents after its key was replaced. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/agent-key">) => {
  const { id } = await ctx.params;
  const body = await readBody<{ fingerprint?: unknown }>(req);
  const before = getInstance(id).agent_fingerprint;
  const inst = acceptAgentKey(id, body.fingerprint);
  audit(req, { action: "host.agent_key", instance: id, detail: `${before ?? "none"} → ${inst.agent_fingerprint}` });
  return json({ id, agent_fingerprint: inst.agent_fingerprint });
});
