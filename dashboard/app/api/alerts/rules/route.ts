import { listRules, saveRules } from "@/lib/alerts";
import { channelIds } from "@/lib/notify";
import { handle, json, paddock, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ rules: listRules() }));

/** The complete rule list: rules left out are deleted, and their firing alerts resolve. */
export const PUT = handle(async (req: Request) => {
  const body = await readBody<{ rules?: unknown }>(req);
  return json({ rules: saveRules(body.rules, [...paddock().instances.keys()], channelIds()) });
});
