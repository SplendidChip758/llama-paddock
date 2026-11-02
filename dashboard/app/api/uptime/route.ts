import { HttpError, handle, json, paddock } from "@/lib/server";
import { UPTIME_RANGES, hostAvailability, isUptimeRange } from "@/lib/uptime";

export const dynamic = "force-dynamic";

/** ?range=24h|7d|30d (default 30d): every host's uptime percentages and outage counts, without the timelines. */
export const GET = handle(async (req: Request) => {
  const range = new URL(req.url).searchParams.get("range") ?? "30d";
  if (!isUptimeRange(range)) throw new HttpError(400, `range must be one of ${UPTIME_RANGES.join(", ")}`);
  const hosts: Record<string, unknown> = {};
  for (const [id, st] of paddock().instances) {
    const a = hostAvailability(id, range, !!st.inst.agent_url);
    const brief = (x: typeof a.ollama | null) => x && { up_pct: x.up_pct, outages: x.outages.length };
    hosts[id] = { coverage: a.coverage, ollama: brief(a.ollama), agent: brief(a.agent) };
  }
  return json({ range, hosts });
});
