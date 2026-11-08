import { listRules, saveRules } from "@/lib/alerts";
import { channelIds } from "@/lib/notify";
import { handle, json, paddock, readBody } from "@/lib/server";
import { audit, listDiff } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ rules: listRules() }));

/** The complete rule list: rules left out are deleted, and their firing alerts resolve. */
export const PUT = handle(async (req: Request) => {
  const body = await readBody<{ rules?: unknown }>(req);
  const before = listRules();
  const rules = saveRules(body.rules, [...paddock().instances.keys()], channelIds());
  const changes = listDiff(before, rules);
  if (changes) audit(req, { action: "alert.rules", detail: changes });
  return json({ rules });
});
