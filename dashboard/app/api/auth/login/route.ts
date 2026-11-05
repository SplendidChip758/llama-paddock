import { NextResponse, type NextRequest } from "next/server";
import {
  authEnabled, clearLoginFailures, clientIp, createSession, knownUsername, loginLockedFor, loginLockedGlobally, noteLoginFailure,
  sessionCookie, verifyLogin,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { HttpError, handle, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  if (!authEnabled()) return NextResponse.json({ ok: true, must_change: false });

  const ip = clientIp(req);
  const wait = loginLockedGlobally() || loginLockedFor(ip);
  if (wait) throw new HttpError(429, `too many failed attempts, try again in ${Math.ceil(wait / 60)} min`);

  const { username, password } = await readBody<{ username?: unknown; password?: unknown }>(req);
  const user = await verifyLogin(String(username ?? ""), String(password ?? ""));
  if (!user) {
    noteLoginFailure(ip);
    // an unknown name may be a password typed into the wrong field, so only a real account is named
    const known = knownUsername(String(username ?? ""));
    audit(req, { action: "auth.login_failed", user: known, detail: known ? "wrong password" : "unknown username" });
    throw new HttpError(401, "wrong username or password");
  }
  clearLoginFailures(ip);
  audit(req, { action: "auth.login", user: user.username });

  const res = NextResponse.json({ ok: true, must_change: user.must_change });
  res.cookies.set(sessionCookie(req, createSession(user.username)));
  return res;
});
