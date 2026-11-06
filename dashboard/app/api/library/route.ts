import { CAPABILITIES, searchLibrary } from "@/lib/library";
import { HttpError, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Search the Ollama library: ?q=, &capability=tools|vision|thinking|embedding|audio|cloud, &sort=popular|newest, &page=. */
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const capability = q.get("capability") || null;
  if (capability && !(CAPABILITIES as readonly string[]).includes(capability)) throw new HttpError(400, `capability must be one of ${CAPABILITIES.join(", ")}`);
  const sort = q.get("sort") || "popular";
  if (sort !== "popular" && sort !== "newest") throw new HttpError(400, "sort must be popular or newest");
  const page = Number(q.get("page") || 1);
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new HttpError(400, "page must be a whole number from 1 to 100");
  return json(await searchLibrary({ q: (q.get("q") ?? "").trim().slice(0, 200), capability, sort, page }));
});
