import { handle, json, switchAgentToHttps } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Address an http:// agent with https://, pinning the key it reports. */
export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/agent-https">) => {
  const { id } = await ctx.params;
  const inst = await switchAgentToHttps(id);
  return json({ id, agent_url: inst.agent_url, agent_fingerprint: inst.agent_fingerprint });
});
