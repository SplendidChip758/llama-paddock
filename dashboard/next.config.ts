import type { NextConfig } from "next";

// The dashboard is never meant to be framed: a same-site page could otherwise overlay a signed-in
// frame and trick clicks on Restart or Delete. A script-restricting CSP needs per-request nonces,
// so it can come later; the wall display (#11) may want frame-ancestors relaxed for one page.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  headers: async () => [{ source: "/(.*)", headers: securityHeaders }],
};

export default nextConfig;
