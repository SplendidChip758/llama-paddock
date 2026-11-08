import type { NextRequest } from "next/server";
import { listUsers, notSelf, removeUser, requireAdmin, setRole } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { handle, json, readBody } from "@/lib/server";

const roleOf = (name: string) => listUsers().find((u) => u.username.toLowerCase() === name.toLowerCase())?.role;

export const dynamic = "force-dynamic";

export const PUT = handle(async (req: NextRequest, ctx: RouteContext<"/api/users/[name]">) => {
  const session = requireAdmin(req);
  const { name } = await ctx.params;
  notSelf(session, name, "change the role of");
  const { role } = await readBody<{ role?: unknown }>(req);
  const before = roleOf(name);
  const user = setRole(name, role);
  if (before !== user.role) audit(req, { action: "user.role", target: user.username, detail: `${before} → ${user.role}` });
  return json(user);
});

export const DELETE = handle(async (req: NextRequest, ctx: RouteContext<"/api/users/[name]">) => {
  const session = requireAdmin(req);
  const { name } = await ctx.params;
  notSelf(session, name, "remove");
  const role = roleOf(name);
  removeUser(name);
  audit(req, { action: "user.remove", target: name, detail: `was ${role}; their tokens were revoked` });
  return json({ ok: true });
});
