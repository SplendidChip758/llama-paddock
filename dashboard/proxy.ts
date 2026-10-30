import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, readSession, trustedProxies } from "./lib/auth";

const AUTH_PAGES = ["/login", "/change-password"];

/**
 * Is a state-changing API request from this dashboard's own pages?
 *
 * The session cookie is SameSite=Lax, which keeps other *sites* out, but a page on another port
 * of the same host, or on a sibling subdomain, is the same site and gets the cookie. A POST with a
 * text/plain body also needs no preflight, so such a page could restart Ollama or pull a model.
 * Browsers say where a request comes from: Sec-Fetch-Site on current ones, Origin on older ones.
 * Requests with neither header (curl, scripts) are let through.
 */
function sameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  // behind a trusted proxy the browser's Host may only survive in X-Forwarded-Host
  const hosts = [req.headers.get("host"), trustedProxies() ? req.headers.get("x-forwarded-host") : null];
  return hosts.some((h) => h && h.split(",")[0].trim().toLowerCase() === host.toLowerCase());
}

/** Session check for every page and API route; see lib/auth.ts. */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isApi && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return NextResponse.json({ detail: "cross-origin request refused" }, { status: 403 });
  }

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
