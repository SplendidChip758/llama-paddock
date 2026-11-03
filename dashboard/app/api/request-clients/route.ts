import { clientNames, saveClientNames } from "@/lib/requests";
import { handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Names given to client addresses in the request logs, such as "open-webui". */
export const GET = handle(async () => json({ names: clientNames() }));

/** {names: {address: name}} replaces them all; a blank name removes one. */
export const PUT = handle(async (req: Request) => {
  const body = await readBody<{ names?: unknown }>(req);
  return json({ names: saveClientNames(body.names) });
});
