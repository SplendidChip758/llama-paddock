import { listChannels, saveChannels } from "@/lib/notify";
import { handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ channels: listChannels() }));

/** The complete channel list: channels left out are deleted. A blank url, token or password keeps the stored one. */
export const PUT = handle(async (req: Request) => {
  const body = await readBody<{ channels?: unknown }>(req);
  return json({ channels: saveChannels(body.channels) });
});
