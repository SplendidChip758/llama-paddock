import { alertTransitions } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** ?after=<id> for the transitions since one already seen, else the latest; limit 1–1000 (default 200). */
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const after = q.get("after");
  const limit = Number(q.get("limit") ?? 200);
  if (after !== null && !/^\d+$/.test(after)) throw new HttpError(400, "after must be a transition id");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, "limit must be from 1 to 1000");
  return json({ transitions: alertTransitions(after === null ? null : Number(after), limit) });
});
