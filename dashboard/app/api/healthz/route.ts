import { version } from "@/package.json";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, version });
}
