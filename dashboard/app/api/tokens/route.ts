import type { NextRequest } from "next/server";
import { requireSession, usernamesById } from "@/lib/auth";
import { createCredential, listCredentials, tokenInfo, type Credential } from "@/lib/credentials";
import { audit } from "@/lib/audit";
import { HttpError, handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Your own tokens; ?all=1 lists everyone's, for admins. */
export const GET = handle(async (req: NextRequest) => {
  const session = requireSession(req);
  if (req.nextUrl.searchParams.get("all") === "1") {
    if (session.role !== "admin") throw new HttpError(403, "only admins can list everyone's tokens");
    const names = usernamesById();
    // tokens of a removed user are already gone; skip any left by an interrupted removal
    return json({ tokens: listCredentials((c) => names.has(c.user)).map((c) => tokenInfo(c, names)) });
  }
  return json({ tokens: listCredentials((c) => c.user === session.id).map((c) => tokenInfo(c)) });
});

/** The token is returned once, here, and only its hash is stored. */
export const POST = handle(async (req: NextRequest) => {
  const session = requireSession(req);
  const body = await readBody<{ name?: unknown; kind?: unknown; scopes?: unknown; expires_days?: unknown }>(req);
  const kind = String(body.kind ?? "api");
  if (!["api", "display", "gateway"].includes(kind)) throw new HttpError(400, "kind must be api");
  const { token, credential } = createCredential({
    kind: kind as Credential["kind"], user: session.id, role: session.role,
    name: body.name, scopes: body.scopes ?? ["api:read"], expiresDays: body.expires_days,
  });
  const exp = credential.expires ? `, expires ${new Date(credential.expires * 1000).toISOString().slice(0, 10)}` : ", no expiry";
  audit(req, { action: "token.create", target: credential.name, detail: `${credential.kind} token ${credential.id}, ${credential.scopes.join(" ")}${exp}` });
  return json({ ...tokenInfo(credential), token }, 201);
});
