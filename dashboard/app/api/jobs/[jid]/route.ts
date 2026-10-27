import { cancelJob, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/jobs/[jid]">) => {
  const { jid } = await ctx.params;
  cancelJob(jid);
  return json({ ok: true });
});
