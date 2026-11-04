import { HttpError, getState, handle, json } from "@/lib/server";
import { REQUEST_RANGES, isRequestRange, requestLogPage } from "@/lib/requests";

export const dynamic = "force-dynamic";

/** ?range=…&sort=latest|slowest&offset=0&limit=25&to=…: one page of the host's requests. */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/requests/log">) => {
  const { id } = await ctx.params;
  getState(id);
  const params = new URL(req.url).searchParams;
  const range = params.get("range") ?? "24h";
  if (!isRequestRange(range)) throw new HttpError(400, `range must be one of ${Object.keys(REQUEST_RANGES).join(", ")}`);
  return json(requestLogPage(id, range, params));
});
