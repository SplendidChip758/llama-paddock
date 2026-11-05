import { handle, json, switchAgentToHttps } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Address an http:// agent with https://, pinning the key it reports. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/agent-https">) => {
  const { id } = await ctx.params;
  const inst = await switchAgentToHttps(id);
  audit(req, { action: "host.agent_https", instance: id, detail: `${inst.agent_url}, pinned ${inst.agent_fingerprint}` });
  return json({ id, agent_url: inst.agent_url, agent_fingerprint: inst.agent_fingerprint });
});
