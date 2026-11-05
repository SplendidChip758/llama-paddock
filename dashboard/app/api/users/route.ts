import type { NextRequest } from "next/server";
import { addUser, listUsers, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  requireAdmin(req);
  return json({ users: listUsers() });
});

/** The temporary password is returned once, for the admin to hand over; it must be changed on first sign-in. */
export const POST = handle(async (req: NextRequest) => {
  requireAdmin(req);
  const { username, role } = await readBody<{ username?: unknown; role?: unknown }>(req);
  const name = String(username ?? "").trim();
  const password = addUser(name, role ?? "viewer");
  audit(req, { action: "user.add", target: name, detail: `role ${String(role ?? "viewer")}` });
  return json({ username: name, password }, 201);
});
