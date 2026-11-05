import { listRules, listSilences, removeSilence } from "@/lib/alerts";
import { audit } from "@/lib/audit";
import { HttpError, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** End a silence or acknowledgement early. */
export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/alerts/silences/[sid]">) => {
  const { sid } = await ctx.params;
  if (!/^\d+$/.test(sid)) throw new HttpError(400, "not a silence id");
  const s = listSilences().find((x) => x.id === Number(sid));
  removeSilence(Number(sid));
  if (s) {
    const rule = s.rule ? listRules().find((r) => r.id === s.rule)?.name ?? s.rule : "all rules";
    audit(req, { action: "alert.unsilence", instance: s.instance, target: [rule, s.subject].filter(Boolean).join(" · "), detail: s.until_resolved ? "acknowledgement" : "" });
  }
  return json({ ok: true });
});
