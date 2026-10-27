import { addInstance, handle, json, paddock, readBody } from "@/lib/server";
import type { InstanceInput } from "@/lib/config";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const p = paddock();
  return json({
    poll_interval: p.settings.poll_interval,
    instances: [...p.instances.values()].map((s) => s.snapshot()),
  });
});

export const POST = handle(async (req: Request) => {
  const inst = addInstance(await readBody<InstanceInput>(req));
  return json({ id: inst.id }, 201);
});
