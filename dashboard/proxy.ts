import { NextResponse, type NextRequest } from "next/server";

/** Optional HTTP basic auth, enabled when PADDOCK_USERNAME and PADDOCK_PASSWORD are both set. */
export function proxy(req: NextRequest) {
  const user = process.env.PADDOCK_USERNAME;
  const pass = process.env.PADDOCK_PASSWORD;
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const sep = decoded.indexOf(":");
      if (sep >= 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), pass)) {
        return NextResponse.next();
      }
    } catch {
      /* fall through */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="llama-paddock"' },
  });
}

function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!api/healthz|_next/static|_next/image|favicon.ico).*)"],
};
