import { audit } from "@/lib/audit";
import { fixDataFiles } from "@/lib/security";
import { HttpError, handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

/** {check: "data_files"}: make the data directory 700 and its files 600. Other checks are fixed where they link to. */
export const POST = handle(async (req: Request) => {
  const body = await readBody<{ check?: unknown }>(req);
  if (body.check !== "data_files") throw new HttpError(400, "only the data_files check can be fixed here");
  if (process.platform === "win32") throw new HttpError(400, "file modes can't be set on Windows");
  const r = fixDataFiles();
  if (r.changed.length) audit(req, { action: "security.fix", target: "data files", detail: r.changed.join(", ") });
  if (r.failed.length && !r.changed.length) throw new HttpError(500, `couldn't change: ${r.failed.join("; ")}`);
  return json(r);
});
