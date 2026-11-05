import type { NextRequest } from "next/server";
import { requireSession, usernamesById } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { deleteCredential, getCredential } from "@/lib/credentials";
import { HttpError, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Revoke a token: your own, or anyone's for an admin. Someone else's answers 404, as if it didn't exist. */
export const DELETE = handle(async (req: NextRequest, ctx: RouteContext<"/api/tokens/[id]">) => {
  const session = requireSession(req);
  const { id } = await ctx.params;
  const cred = getCredential(id);
  if (!cred || (cred.user !== session.id && session.role !== "admin")) throw new HttpError(404, "no such token");
  deleteCredential(id);
  const owner = cred.user === session.id ? "" : `, owned by ${usernamesById().get(cred.user) ?? "a removed user"}`;
  audit(req, { action: "token.revoke", target: cred.name, detail: `${cred.kind} token ${cred.id}${owner}` });
  return json({ ok: true });
});
