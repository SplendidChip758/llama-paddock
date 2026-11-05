import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE, authEnabled, bearerToken, clearTokenFailures, clientIp, noteTokenFailure, readSession, tokenLockedFor,
  trustedProxies, verifyToken, type Session,
} from "./lib/auth";
import type { Scope } from "./lib/credentials";

const AUTH_PAGES = ["/login", "/change-password"];

/** What any signed-in user may do to their own session, password and tokens. */
const OWN_ACCOUNT = ["/api/auth/login", "/api/auth/logout", "/api/auth/password"];
/** /api/tokens checks ownership itself: a viewer manages their own tokens, an admin anyone's. */
const OWN_TOKENS = /^\/api\/tokens(\/|$)/;
/** POST requests that only read, such as a model's details, which viewers need too. */
const READ_ONLY_POSTS = [/^\/api\/instances\/[^/]+\/models\/(show|fit)$/, /^\/api\/instances\/[^/]+\/gpu-check$/];

/** Pages and APIs that viewers can't even read: accounts, and the audit log of who did what. */
const ADMIN_ONLY = /^\/(api\/)?(users|audit)(\/|$)/;

/**
 * Viewers see everything but change nothing. Checked here rather than in each route, so a new
 * route is admin-only for writes unless it is listed above.
 */
function allowed(session: Session, method: string, pathname: string): boolean {
  if (session.role === "admin") return true;
  if (ADMIN_ONLY.test(pathname)) return false;
  if (method === "GET" || method === "HEAD") return true;
  return OWN_ACCOUNT.includes(pathname) || OWN_TOKENS.test(pathname) || (method === "POST" && READ_ONLY_POSTS.some((re) => re.test(pathname)));
}

/** Accounts, tokens and passwords are managed from a browser session only, so a leaked token can't mint another or lock its owner out. */
const SESSION_ONLY = /^\/api\/(users|tokens|auth)(\/|$)/;

/**
 * The scope a credential needs for this request, or null when no credential may make it. Every token
 * request goes through here, and anything not matched is refused, so a new route is covered by its
 * path: writes need api:write unless listed in READ_ONLY_POSTS.
 */
function requiredScope(method: string, pathname: string): Scope | null {
  const read = method === "GET" || method === "HEAD";
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return "gateway:invoke"; // M7 gateway
  if (pathname.startsWith("/api/display/")) return read ? "display:read" : null; // #11 wall display feed
  if (pathname === "/api/auth/me") return read ? "api:read" : null; // so a script can check what its token is
  if (SESSION_ONLY.test(pathname)) return null;
  if (!pathname.startsWith("/api/")) return null; // pages are for browsers
  if (read || (method === "POST" && READ_ONLY_POSTS.some((re) => re.test(pathname)))) return "api:read";
  return "api:write";
}

/** Percent-decoded, so /api/%75sers is classified as /api/users. Undecodable paths keep their raw form. */
function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

const unauthorized = (detail: string, code: string) =>
  NextResponse.json({ detail, code }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="llama-paddock"' } });

/** A request with `Authorization: Bearer`: the token alone decides, whatever cookie comes with it. */
function tokenRequest(req: NextRequest, token: string) {
  const ip = clientIp(req);
  const wait = tokenLockedFor(ip);
  if (wait) {
    return NextResponse.json({ detail: `too many failed token attempts, try again in ${Math.ceil(wait / 60)} min` }, { status: 429, headers: { "Retry-After": String(wait) } });
  }
  const check = verifyToken(token);
  if (!check.caller) {
    if (check.guess) noteTokenFailure(ip);
    return unauthorized(check.detail, "bad_token");
  }
  clearTokenFailures(ip);
  const need = requiredScope(req.method, decodedPath(req.nextUrl.pathname));
  if (!need) return NextResponse.json({ detail: "this needs a signed-in session, not a token", code: "session_only" }, { status: 403 });
  if (!check.caller.scopes.includes(need)) {
    return NextResponse.json({ detail: `this token doesn't have the ${need} scope`, code: "forbidden", scope: need }, { status: 403 });
  }
  return NextResponse.next();
}

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
  // Prometheus can't sign in: the route checks its own scrape token (app/metrics/route.ts)
  if (pathname === "/metrics") return NextResponse.next();

  if (isApi && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return NextResponse.json({ detail: "cross-origin request refused" }, { status: 403 });
  }

  if (!authEnabled()) {
    return AUTH_PAGES.includes(pathname) ? NextResponse.redirect(new URL("/", req.url)) : NextResponse.next();
  }

  const token = bearerToken(req);
  if (token !== undefined) return tokenRequest(req, token);

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

  if (!allowed(session, req.method, pathname)) {
    if (isApi) return NextResponse.json({ detail: "your account is read-only", code: "forbidden" }, { status: 403 });
    return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/healthz|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
