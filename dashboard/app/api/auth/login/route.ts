import { NextResponse, type NextRequest } from "next/server";
import {
  authEnabled, clearLoginFailures, clientIp, createSession, loadAuth, loginLockedFor, loginLockedGlobally, noteLoginFailure,
  sessionCookie, verifyLogin,
} from "@/lib/auth";
import { HttpError, handle, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  if (!authEnabled()) return NextResponse.json({ ok: true, must_change: false });

  const ip = clientIp(req);
  const wait = loginLockedGlobally() || loginLockedFor(ip);
  if (wait) throw new HttpError(429, `too many failed attempts, try again in ${Math.ceil(wait / 60)} min`);

  const { username, password } = await readBody<{ username?: unknown; password?: unknown }>(req);
  if (!(await verifyLogin(String(username ?? ""), String(password ?? "")))) {
    noteLoginFailure(ip);
    throw new HttpError(401, "wrong username or password");
  }
  clearLoginFailures(ip);

  const res = NextResponse.json({ ok: true, must_change: loadAuth().must_change });
  res.cookies.set(sessionCookie(req, createSession()));
  return res;
});
