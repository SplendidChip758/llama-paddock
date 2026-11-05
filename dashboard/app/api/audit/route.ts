import type { NextRequest } from "next/server";
import { authEnabled, currentCaller } from "@/lib/auth";
import { auditFacets, listAudit } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/server";
import { AUDIT_ACTIONS, AUDIT_GROUPS } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The audit log, newest first: ?user=, ?instance=, ?action= (one action, or a group such as "model"),
 * ?before=<id> for the next page, limit 1–500 (default 100). Admins only, with a session or a token.
 */
export const GET = handle(async (req: NextRequest) => {
  // proxy.ts keeps viewer sessions out; this also covers viewers' tokens
  if (authEnabled() && currentCaller(req)?.role !== "admin") throw new HttpError(403, "only admins can read the audit log");
  const q = req.nextUrl.searchParams;
  const limit = Number(q.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit must be from 1 to 500");
  const before = q.get("before");
  if (before !== null && !/^\d+$/.test(before)) throw new HttpError(400, "before must be an entry id");
  const action = q.get("action") || undefined;
  if (action && !(action in AUDIT_ACTIONS) && !(action in AUDIT_GROUPS)) throw new HttpError(400, `unknown action ${action}`);
  const entries = listAudit({ user: q.get("user") || undefined, instance: q.get("instance") || undefined, action, before: before ? Number(before) : undefined }, limit);
  return json({
    entries,
    // the id to pass as ?before= for older entries, or null at the end
    next: entries.length === limit ? entries[entries.length - 1].id : null,
    ...auditFacets(),
  });
});
