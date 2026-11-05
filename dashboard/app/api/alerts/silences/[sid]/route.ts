import { removeSilence } from "@/lib/alerts";
import { HttpError, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** End a silence or acknowledgement early. */
export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/alerts/silences/[sid]">) => {
  const { sid } = await ctx.params;
  if (!/^\d+$/.test(sid)) throw new HttpError(400, "not a silence id");
  removeSilence(Number(sid));
  return json({ ok: true });
});
