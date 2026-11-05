import { addSilence, listRules, listSilences } from "@/lib/alerts";
import { audit } from "@/lib/audit";
import { fmtDur } from "@/lib/format";
import { handle, json, paddock, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ silences: listSilences() }));

/** {rule?, instance?, subject?, duration_s, note?} silences for a while; {rule, instance, subject, until_resolved: true} acknowledges one alert. */
export const POST = handle(async (req: Request) => {
  const body = await readBody(req);
  const silence = addSilence(body, [...paddock().instances.keys()]);
  const rule = silence.rule ? listRules().find((r) => r.id === silence.rule)?.name ?? silence.rule : "all rules";
  audit(req, {
    action: "alert.silence", instance: silence.instance, target: [rule, silence.subject].filter(Boolean).join(" · "),
    detail: silence.until_resolved ? "acknowledged until it resolves" : `for ${fmtDur(silence.until! - silence.created)}`,
  });
  return json({ silence }, 201);
});
