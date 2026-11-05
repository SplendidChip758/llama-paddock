import { audit } from "@/lib/audit";
import { SECURITY_CHECKS, undismissCheck } from "@/lib/security";
import { handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Count a dismissed check again. */
export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/security/dismissals/[instance]/[check]">) => {
  const { instance, check } = await ctx.params;
  const d = undismissCheck(instance, check);
  audit(req, { action: "security.undismiss", instance: SECURITY_CHECKS[d.check].target === "host" ? d.instance : null, target: SECURITY_CHECKS[d.check].label });
  return json({ ok: true });
});
