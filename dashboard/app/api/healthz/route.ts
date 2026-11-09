import { version } from "@/package.json";
import { AGENT_PROTOCOL } from "@/lib/protocol";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, version, agent_protocol: AGENT_PROTOCOL });
}
