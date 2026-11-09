import { handle, json, paddock } from "@/lib/server";
import { audit } from "@/lib/audit";
import { currentCaller } from "@/lib/auth";
import { dashboardUpdate, refreshDashboardRelease, requestDashboardUpdate, type UpdateBody } from "@/lib/dashboardUpdate";
import type { AuditAction } from "@/lib/types";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Whether a newer dashboard is out, how this install updates, and its update history; ?refresh=1 asks GitHub again first. */
export const GET = handle(async (req: Request) => {
  const settings = paddock().settings;
  if (new URL(req.url).searchParams.get("refresh") === "1") await refreshDashboardRelease(settings);
  return json(dashboardUpdate(settings));
});

const AUDIT: Record<string, AuditAction> = {
  update: "dashboard.update", rollback: "dashboard.rollback", channel: "dashboard.channel", auto: "dashboard.auto_update",
};

/**
 * Ask the installer's updater for something. {action}: update (the default; {version} must be the
 * newest release), rollback ({backup} of a history entry), channel ({channel}: stable or dev) or auto
 * ({enabled}). Admins only (proxy.ts).
 */
export const POST = handle(async (req: NextRequest) => {
  const body = ((await req.json().catch(() => ({}))) ?? {}) as UpdateBody;
  const settings = paddock().settings;
  const a = requestDashboardUpdate(settings, body, currentCaller(req)?.username ?? null);
  audit(req, { action: AUDIT[String(body.action ?? "update")], target: a.target, detail: a.detail });
  return json(dashboardUpdate(settings));
});
