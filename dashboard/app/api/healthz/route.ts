import { version } from "@/package.json";
import { AGENT_PROTOCOL } from "@/lib/protocol";
import { storageFailures } from "@/lib/storage";

export const dynamic = "force-dynamic";

// storage_ok without the details, which /api/storage gives to signed-in users
export function GET() {
  return Response.json({ ok: true, version, agent_protocol: AGENT_PROTOCOL, storage_ok: storageFailures().length === 0 });
}
