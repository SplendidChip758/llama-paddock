import { HttpError, agent, getInstance, handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/instances/[id]/env">) => {
  const { id } = await ctx.params;
  return json(await agent(getInstance(id), "GET", "/env"));
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/env">) => {
  const { id } = await ctx.params;
  const body = await readBody<{ vars?: unknown; restart?: unknown }>(req);
  if (!body.vars || typeof body.vars !== "object" || Array.isArray(body.vars)) throw new HttpError(400, "vars must be an object");
  return json(await agent(getInstance(id), "PUT", "/env", { vars: body.vars, restart: body.restart !== false }, 120_000));
});
