import { acceptAgentKey, handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Pin a new key for an https:// agent, e.g. the one it presents after its key was replaced. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/agent-key">) => {
  const { id } = await ctx.params;
  const body = await readBody<{ fingerprint?: unknown }>(req);
  const inst = acceptAgentKey(id, body.fingerprint);
  return json({ id, agent_fingerprint: inst.agent_fingerprint });
});
