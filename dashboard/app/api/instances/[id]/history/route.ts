import { RANGES, rangeHistory, recentHistory, type HistoryRange } from "@/lib/db";
import { HttpError, getState, handle, json, paddock } from "@/lib/server";

export const dynamic = "force-dynamic";

/** No range: the latest `history_points` raw polls (sparklines). ?range=1h|6h|24h|7d|30d: a downsampled chart range. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/history">) => {
  const { id } = await ctx.params;
  getState(id);
  const range = new URL(req.url).searchParams.get("range");
  if (range === null) return json({ resolution: 0, points: recentHistory(id, paddock().settings.history_points) });
  if (!Object.hasOwn(RANGES, range)) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join(", ")}`);
  return json(rangeHistory(id, range as HistoryRange));
});
