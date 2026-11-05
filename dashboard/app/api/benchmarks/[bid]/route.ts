import { benchmarkDetail, removeBenchmark } from "@/lib/bench";
import { handle, json } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** One benchmark with every run. */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/benchmarks/[bid]">) => {
  const { bid } = await ctx.params;
  return json(benchmarkDetail(bid));
});

/** Cancels a running benchmark, keeping the runs it finished, or deletes a finished one. */
export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/benchmarks/[bid]">) => {
  const { bid } = await ctx.params;
  const b = benchmarkDetail(bid);
  removeBenchmark(bid);
  audit(req, {
    action: b.state === "running" ? "benchmark.cancel" : "benchmark.delete",
    instance: b.instance, instanceName: b.instance_name, target: b.model, detail: `${b.id}, started ${new Date(b.started * 1000).toISOString()}`,
  });
  return json({ ok: true });
});
