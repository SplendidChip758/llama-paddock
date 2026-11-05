import { benchmarkDetail, removeBenchmark } from "@/lib/bench";
import { handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** One benchmark with every run. */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/benchmarks/[bid]">) => {
  const { bid } = await ctx.params;
  return json(benchmarkDetail(bid));
});

/** Cancels a running benchmark, keeping the runs it finished, or deletes a finished one. */
export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/benchmarks/[bid]">) => {
  const { bid } = await ctx.params;
  removeBenchmark(bid);
  return json({ ok: true });
});
