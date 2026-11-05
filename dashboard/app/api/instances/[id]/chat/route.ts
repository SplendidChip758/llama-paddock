import { getInstance, handle, readBody } from "@/lib/server";
import { parseChatRequest, streamChat } from "@/lib/prompt";
import type { PromptEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A test prompt: Ollama's answer as newline-delimited JSON events, ending with its timings. */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/instances/[id]/chat">) => {
  const { id } = await ctx.params;
  const inst = getInstance(id);
  const events = await streamChat(inst, parseChatRequest(await readBody(req)), req.signal);
  const enc = new TextEncoder();
  const line = (e: PromptEvent) => enc.encode(JSON.stringify(e) + "\n");
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { value, done } = await events.next();
      if (done) ctrl.close();
      else ctrl.enqueue(line(value));
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform" },
  });
});
