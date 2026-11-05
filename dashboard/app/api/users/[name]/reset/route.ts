import type { NextRequest } from "next/server";
import { notSelf, requireAdmin, resetPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Signs the user out and returns a temporary password, once. Admins change their own under Change password. */
export const POST = handle(async (req: NextRequest, ctx: RouteContext<"/api/users/[name]/reset">) => {
  const session = requireAdmin(req);
  const { name } = await ctx.params;
  notSelf(session, name, "reset the password of");
  const password = resetPassword(name);
  audit(req, { action: "user.reset", target: name, detail: "signed out everywhere, temporary password issued" });
  return json({ password });
});
