import { NextResponse, type NextRequest } from "next/server";
import {
  MIN_PASSWORD, SESSION_COOKIE, authEnabled, changePassword, checkPassword, createSession, readSession, sessionCookie,
} from "@/lib/auth";
import { HttpError, handle, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  if (!authEnabled()) throw new HttpError(400, "login is disabled (PADDOCK_AUTH=off)");
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) throw new HttpError(401, "not signed in");

  const { current, password } = await readBody<{ current?: unknown; password?: unknown }>(req);
  const next = String(password ?? "");
  // On the forced first-login change the user has just entered the current password.
  if (!session.mustChange && !(await checkPassword(String(current ?? "")))) throw new HttpError(400, "current password is wrong");
  if (next.length < MIN_PASSWORD) throw new HttpError(400, `new password must be at least ${MIN_PASSWORD} characters`);
  if (await checkPassword(next)) throw new HttpError(400, "new password must differ from the current one");

  changePassword(next);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(req, createSession()));
  return res;
});
