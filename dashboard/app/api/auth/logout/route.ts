import { NextResponse, type NextRequest } from "next/server";
import { sessionCookie } from "@/lib/auth";
import { handle } from "@/lib/server";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: NextRequest) => {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(req, "", 0));
  return res;
});
