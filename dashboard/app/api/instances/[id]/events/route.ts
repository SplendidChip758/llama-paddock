import { RANGES, eventHistory, type HistoryRange } from "@/lib/db";
import { HttpError, getState, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** ?range=1h|6h|24h|7d|30d (default 24h): observed spans, availability and model load events. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/events">) => {
  const { id } = await ctx.params;
  const st = getState(id);
  const range = new URL(req.url).searchParams.get("range") ?? "24h";
  if (!Object.hasOwn(RANGES, range)) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join(", ")}`);
  return json(eventHistory(id, range as HistoryRange, !!st.inst.agent_url));
});
