import { cancelJob, handle, json, listJobs } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/jobs/[jid]">) => {
  const { jid } = await ctx.params;
  const job = listJobs().find((j) => j.id === jid);
  cancelJob(jid);
  // clearing a finished job from the list changes nothing worth recording
  if (job?.state === "running") audit(req, { action: "job.cancel", instance: job.instance, target: job.model, detail: `${job.kind} job ${job.id}` });
  return json({ ok: true });
});
