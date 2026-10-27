import { handle, json, paddock } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const p = paddock();
  return json({
    poll_interval: p.settings.poll_interval,
    instances: [...p.instances.values()].map((s) => s.snapshot()),
  });
});
