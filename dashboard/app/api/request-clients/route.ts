import { clientNames, saveClientNames } from "@/lib/requests";
import { handle, json, readBody } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Names given to client addresses in the request logs, such as "open-webui". */
export const GET = handle(async () => json({ names: clientNames() }));

/** {names: {address: name}} replaces them all; a blank name removes one. */
export const PUT = handle(async (req: Request) => {
  const body = await readBody<{ names?: unknown }>(req);
  const before = clientNames();
  const names = saveClientNames(body.names);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(names)])].filter((a) => before[a] !== names[a])
    .map((a) => `${a}: ${before[a] ?? "unnamed"} → ${names[a] ?? "unnamed"}`);
  if (changed.length) audit(req, { action: "settings.client_names", detail: changed.join("; ") });
  return json({ names });
});
