export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, version: "1.0.0" });
}
