import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, checkPassword, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { exportConfig } from "@/lib/configExport";
import { HttpError, handle, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * The configuration as a file to download: hosts with their tokens and keys, users, API tokens,
 * alert rules and channels. Sealed with a passphrase, unless `unencrypted: true` says otherwise.
 * It hands over every secret the dashboard holds, so the admin confirms their password.
 */
export const POST = handle(async (req: NextRequest) => {
  const body = await readBody<{ passphrase?: unknown; unencrypted?: unknown; password?: unknown }>(req);
  if (authEnabled()) {
    const session = requireAdmin(req);
    if (!(await checkPassword(session.username, String(body.password ?? "")))) throw new HttpError(400, "your password is wrong");
  }
  const unencrypted = body.unencrypted === true;
  if (!unencrypted && typeof body.passphrase !== "string") throw new HttpError(400, "a passphrase, or unencrypted: true");
  const file = exportConfig(unencrypted ? null : String(body.passphrase));
  audit(req, { action: "config.export", detail: unencrypted ? "unencrypted" : "encrypted with a passphrase" });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(file, null, 2) + "\n", {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="llama-paddock-config-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
