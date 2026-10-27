import type { NextRequest } from "next/server";
import { MIN_PASSWORD, SESSION_COOKIE, authEnabled, readSession } from "@/lib/auth";
import { handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: NextRequest) => {
  if (!authEnabled()) return json({ auth: false });
  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);
  return json({ auth: true, username: session?.username ?? null, must_change: session?.mustChange ?? false, min_password: MIN_PASSWORD });
});
