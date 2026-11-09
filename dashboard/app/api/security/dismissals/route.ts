import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { currentCaller } from "@/lib/auth";
import { SECURITY_CHECKS, dismissCheck, listDismissals } from "@/lib/security";
import { handle, json, paddock, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ dismissals: listDismissals() }));

/** {instance, check}: the check fails on purpose. instance is a host id, or "@dashboard" for the dashboard's checks. */
export const POST = handle(async (req: NextRequest) => {
  const body = await readBody(req);
  const d = dismissCheck(body, [...paddock().instances.keys()], currentCaller(req)?.username ?? null);
  audit(req, { action: "security.dismiss", instance: SECURITY_CHECKS[d.check].target === "host" ? d.instance : null, target: SECURITY_CHECKS[d.check].label });
  return json({ dismissal: d }, 201);
});
