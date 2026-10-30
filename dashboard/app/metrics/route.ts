import { safeEqual } from "@/lib/auth";
import { CONTENT_TYPE, renderMetrics } from "@/lib/metrics";
import { HttpError, handle, paddock } from "@/lib/server";

export const dynamic = "force-dynamic";

// Prometheus can't sign in, so proxy.ts lets /metrics past the session check and it checks its
// own bearer token here. Off unless a token is set or metrics_open says to leave it open.
export const GET = handle(async (req: Request) => {
  const { metrics_token: token, metrics_open: open } = paddock().settings;
  if (token) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m || !safeEqual(m[1].trim(), token)) throw new HttpError(401, "metrics need the scrape token: Authorization: Bearer <metrics_token>");
  } else if (!open) {
    throw new HttpError(404, "metrics are disabled: set metrics_token (or PADDOCK_METRICS_TOKEN), or metrics_open: true, and restart");
  }
  return new Response(renderMetrics(), { headers: { "Content-Type": CONTENT_TYPE, "Cache-Control": "no-store" } });
});
