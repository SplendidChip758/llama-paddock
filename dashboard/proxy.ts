import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, readSession } from "./lib/auth";

const AUTH_PAGES = ["/login", "/change-password"];

/** Session check for every page and API route; see lib/auth.ts. */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (!authEnabled()) {
    return AUTH_PAGES.includes(pathname) ? NextResponse.redirect(new URL("/", req.url)) : NextResponse.next();
  }

  const session = readSession(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login" || pathname === "/api/auth/login") {
    if (session && pathname === "/login") return NextResponse.redirect(new URL(session.mustChange ? "/change-password" : "/", req.url));
    return NextResponse.next();
  }

  if (!session) {
    if (isApi) return NextResponse.json({ detail: "not signed in" }, { status: 401 });
    const login = new URL("/login", req.url);
    if (pathname !== "/") login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }

  // First login: nothing but the password change until the initial password is replaced.
  if (session.mustChange && pathname !== "/change-password" && !pathname.startsWith("/api/auth/")) {
    if (isApi) return NextResponse.json({ detail: "password change required", code: "must_change" }, { status: 403 });
    return NextResponse.redirect(new URL("/change-password", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/healthz|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
