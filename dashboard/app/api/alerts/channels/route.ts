import { listChannels, saveChannels } from "@/lib/notify";
import { handle, json, readBody } from "@/lib/server";
import { audit, listDiff } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ channels: listChannels() }));

/** The complete channel list: channels left out are deleted. A blank url, token or password keeps the stored one. */
export const PUT = handle(async (req: Request) => {
  const body = await readBody<{ channels?: unknown }>(req);
  const before = listChannels();
  const channels = saveChannels(body.channels);
  // compared as the API shows them, so a new secret alone isn't seen; say when one was sent
  const secrets = Array.isArray(body.channels) && body.channels.some((c) =>
    c && typeof c === "object" && ["url", "token", "password"].some((k) => String((c as Record<string, unknown>)[k] ?? "").trim()));
  const changes = [listDiff(before, channels), secrets ? "a URL, token or password was entered" : ""].filter(Boolean).join("; ");
  if (changes) audit(req, { action: "alert.channels", detail: changes });
  return json({ channels });
});
