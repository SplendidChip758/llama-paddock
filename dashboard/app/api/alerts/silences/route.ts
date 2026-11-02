import { addSilence, listSilences } from "@/lib/alerts";
import { handle, json, paddock, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ silences: listSilences() }));

/** {rule?, instance?, subject?, duration_s, note?} silences for a while; {rule, instance, subject, until_resolved: true} acknowledges one alert. */
export const POST = handle(async (req: Request) => {
  const body = await readBody(req);
  return json({ silence: addSilence(body, [...paddock().instances.keys()]) }, 201);
});
