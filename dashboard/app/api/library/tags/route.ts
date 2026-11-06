import { libraryTags } from "@/lib/library";
import { HttpError, handle, json } from "@/lib/server";

export const dynamic = "force-dynamic";

/** A library model and every tag it has: ?model=qwen3 (or library/qwen3), or user/model for community models. */
export const GET = handle(async (req: Request) => {
  const model = new URL(req.url).searchParams.get("model")?.trim();
  if (!model) throw new HttpError(400, `"model" is required`);
  return json(await libraryTags(model.includes("/") ? model : `library/${model}`));
});
