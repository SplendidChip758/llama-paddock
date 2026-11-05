import type { NextRequest } from "next/server";
import { MIN_PASSWORD, SESSION_COOKIE, authEnabled, currentCaller, readSession } from "@/lib/auth";
import { handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  // with the login off, whoever gets past the auth proxy has full control
  if (!authEnabled()) return json({ auth: false, role: "admin" });
  const caller = currentCaller(req);
  // with a token, say which one and what it may do, so a script can check before it relies on it
  if (caller?.credential) {
    return json({ auth: true, username: caller.username, role: caller.role, must_change: false, token: { ...caller.credential, scopes: caller.scopes } });
  }
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);
  return json({
    auth: true, username: session?.username ?? null, role: session?.role ?? null, must_change: session?.mustChange ?? false, min_password: MIN_PASSWORD,
  });
});
