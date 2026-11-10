import { handle, json, paddock } from "@/lib/server";
import { audit } from "@/lib/audit";
import { currentCaller } from "@/lib/auth";
import { dashboardUpdate, refreshDashboardRelease, requestDashboardUpdate } from "@/lib/dashboardUpdate";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Whether a newer dashboard is out and how this install updates; ?refresh=1 asks GitHub again first. */
export const GET = handle(async (req: Request) => {
  const settings = paddock().settings;
  if (new URL(req.url).searchParams.get("refresh") === "1") await refreshDashboardRelease(settings);
  return json(dashboardUpdate(settings));
});

/** Ask the installer's updater to install the newest release: {version} must name it. Admins only (proxy.ts). */
export const POST = handle(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const settings = paddock().settings;
  const r = requestDashboardUpdate(settings, body?.version, currentCaller(req)?.username ?? null);
  audit(req, { action: "dashboard.update", target: r.latest, detail: `from ${r.current}` });
  return json(r);
});
