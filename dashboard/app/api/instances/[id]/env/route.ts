import { HttpError, agent, expectedRestart, getInstance, handle, json, readBody } from "@/lib/server";
import { audit, envChanges, restartOutcome } from "@/lib/audit";
import type { EnvState } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/env">) => {
  const { id } = await ctx.params;
  return json(await agent(getInstance(id), "GET", "/env"));
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/env">) => {
  const { id } = await ctx.params;
  const body = await readBody<{ vars?: unknown; restart?: unknown }>(req);
  if (!body.vars || typeof body.vars !== "object" || Array.isArray(body.vars)) throw new HttpError(400, "vars must be an object");
  const inst = getInstance(id);
  // read first, so the log can say which keys changed; values are never recorded
  const before = await agent<EnvState>(inst, "GET", "/env").catch(() => null);
  const put = () => agent<{ restart?: { ok: boolean } }>(inst, "PUT", "/env", { vars: body.vars, restart: body.restart !== false }, 120_000);
  const r = body.restart === false ? await put() : await expectedRestart(id, put);
  const restart = body.restart === false ? "not restarted" : r.restart ? restartOutcome(r.restart) || "restarted" : "";
  audit(req, { action: "env.change", instance: id, detail: [envChanges(before, body.vars as Record<string, unknown>), restart].filter(Boolean).join("; ") });
  return json(r);
});
