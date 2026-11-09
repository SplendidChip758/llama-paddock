import { handle, json, paddock } from "@/lib/server";
import { agentReleases, refreshAgentReleases } from "@/lib/agentReleases";

export const dynamic = "force-dynamic";

/** The newest agent release per platform; ?refresh=1 asks GitHub again first. */
export const GET = handle(async (req: Request) => {
  const settings = paddock().settings;
  if (new URL(req.url).searchParams.get("refresh") === "1") await refreshAgentReleases(settings);
  return json(agentReleases(settings));
});
