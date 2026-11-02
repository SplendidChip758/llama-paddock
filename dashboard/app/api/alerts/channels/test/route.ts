import { testChannel } from "@/lib/notify";
import { handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Send a test message through a channel as entered in the editor; a blank secret uses the saved channel's (by id). */
export const POST = handle(async (req: Request) => {
  const body = await readBody<{ channel?: unknown }>(req);
  return json(await testChannel(body.channel));
});
