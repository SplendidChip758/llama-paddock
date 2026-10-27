import { handle, json, readBody, removeInstance, updateInstance } from "@/lib/server";
import type { InstanceInput } from "@/lib/config";

export const dynamic = "force-dynamic";

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]">) => {
  const { id } = await ctx.params;
  updateInstance(id, await readBody<InstanceInput>(req));
  return json({ id });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]">) => {
  const { id } = await ctx.params;
  removeInstance(id);
  return json({ ok: true });
});
