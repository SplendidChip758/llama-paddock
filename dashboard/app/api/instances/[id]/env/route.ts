import { HttpError, agent, expectedRestart, getInstance, handle, json, readBody } from "@/lib/server";

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
  const put = () => agent(inst, "PUT", "/env", { vars: body.vars, restart: body.restart !== false }, 120_000);
  return json(body.restart === false ? await put() : await expectedRestart(id, put));
});
