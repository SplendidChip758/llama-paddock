import { HttpError, getState, handle, json } from "@/lib/server";
import { REQUEST_RANGES, isRequestRange, requestSummary } from "@/lib/requests";

export const dynamic = "force-dynamic";

/** ?range=1h|24h|7d|30d (default 24h): the host's requests from Ollama's log, by time, client, endpoint and model. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/requests">) => {
  const { id } = await ctx.params;
  getState(id);
  const range = new URL(req.url).searchParams.get("range") ?? "24h";
  if (!isRequestRange(range)) throw new HttpError(400, `range must be one of ${Object.keys(REQUEST_RANGES).join(", ")}`);
  return json(requestSummary(id, range));
});
