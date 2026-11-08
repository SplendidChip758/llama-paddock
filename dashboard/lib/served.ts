// How the dashboard was last reached from another machine, for the security checks (#83): proxy.ts
// sees every request, and the poller reads this. No "server-only": proxy.ts imports it.

/** A browser or script on another machine, over https (directly or through a proxy that says so) or not. */
export interface Served {
  t: number;
  https: boolean;
  /** the host name the client used, for the check's detail */
  host: string;
}

const g = globalThis as unknown as { __paddockServed?: Served };

/** localhost, 127.0.0.0/8, ::1 and IPv4-mapped 127.x. Brackets around IPv6 are allowed. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(h);
}

/** The host name in a Host header: "a.lan:8080" → "a.lan", "[::1]:8080" → "::1". */
export function hostName(header: string): string {
  const h = header.trim();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  return h.replace(/:\d+$/, "");
}

/**
 * Note one request. Requests to a loopback name (health checks, a browser on the same machine) say
 * nothing about the network, so only the latest request from elsewhere counts.
 */
export function noteServed(req: { headers: { get(name: string): string | null }; url: string }) {
  const header = req.headers.get("host");
  if (!header) return;
  const host = hostName(header);
  if (!host || isLoopback(host)) return;
  // the same test the session cookie's Secure flag uses
  const https = req.headers.get("x-forwarded-proto") === "https" || new URL(req.url).protocol === "https:";
  g.__paddockServed = { t: Date.now() / 1000, https, host };
}

export const lastServed = (): Served | null => g.__paddockServed ?? null;
