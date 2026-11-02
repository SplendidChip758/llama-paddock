import { HttpError, getState, handle, json } from "@/lib/server";
import { UPTIME_RANGES, hostAvailability, isUptimeRange } from "@/lib/uptime";

export const dynamic = "force-dynamic";

/** ?range=24h|7d|30d (default 30d): Ollama's and the agent's availability, as timelines and outages. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/uptime">) => {
  const { id } = await ctx.params;
  const st = getState(id);
  const range = new URL(req.url).searchParams.get("range") ?? "30d";
  if (!isUptimeRange(range)) throw new HttpError(400, `range must be one of ${UPTIME_RANGES.join(", ")}`);
  return json(hostAvailability(id, range, !!st.inst.agent_url));
});
