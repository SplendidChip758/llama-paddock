import { getInstance, handle, json, readBody, removeInstance, updateInstance } from "@/lib/server";
import { audit, hostChanges } from "@/lib/audit";
import type { InstanceInput } from "@/lib/config";

export const dynamic = "force-dynamic";

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]">) => {
  const { id } = await ctx.params;
  const before = getInstance(id);
  const after = updateInstance(id, await readBody<InstanceInput>(req));
  const changes = hostChanges(before, after);
  if (changes) audit(req, { action: "host.edit", instance: id, detail: changes });
  return json({ id });
});

export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]">) => {
  const { id } = await ctx.params;
  const { name } = getInstance(id);
  removeInstance(id);
  audit(req, { action: "host.remove", instance: id, instanceName: name, detail: "its history was deleted" });
  return json({ ok: true });
});
