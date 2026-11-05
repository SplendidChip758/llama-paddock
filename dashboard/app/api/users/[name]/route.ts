import type { NextRequest } from "next/server";
import { notSelf, removeUser, requireAdmin, setRole } from "@/lib/auth";
import { handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const PUT = handle(async (req: NextRequest, ctx: RouteContext<"/api/users/[name]">) => {
  const session = requireAdmin(req);
  const { name } = await ctx.params;
  notSelf(session, name, "change the role of");
  const { role } = await readBody<{ role?: unknown }>(req);
  return json(setRole(name, role));
});

export const DELETE = handle(async (req: NextRequest, ctx: RouteContext<"/api/users/[name]">) => {
  const session = requireAdmin(req);
  const { name } = await ctx.params;
  notSelf(session, name, "remove");
  removeUser(name);
  return json({ ok: true });
});
