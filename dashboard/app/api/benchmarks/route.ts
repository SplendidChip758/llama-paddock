import { listBenchmarkInfo, parseBenchRequest, startBenchmarks } from "@/lib/bench";
import { HttpError, handle, json, readBody } from "@/lib/server";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Saved benchmarks, newest first: ?instance=<id> and ?model=<name> narrow them, limit 1–500 (default 100). */
export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const limit = Number(q.get("limit") ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit must be from 1 to 500");
  return json({ benchmarks: listBenchmarkInfo({ instance: q.get("instance") ?? undefined, model: q.get("model") ?? undefined }, limit) });
});

/** Start a benchmark of one model on one or more hosts; each runs as a job. */
export const POST = handle(async (req: Request) => {
  const benchmarks = startBenchmarks(parseBenchRequest(await readBody(req)));
  for (const b of benchmarks) {
    const { mode, repeat, cases, num_ctx } = b.spec;
    audit(req, { action: "benchmark.start", instance: b.instance, target: b.model, detail: `${b.id}: ${mode}, ${repeat}× ${cases.join(", ")} at ${num_ctx} context` });
  }
  return json({ benchmarks });
});
