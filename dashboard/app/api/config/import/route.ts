import type { NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, readSession, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { importConfig } from "@/lib/configExport";
import { handle, json, readBody } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * Import a configuration export. `dry_run: true` only lists what would be added, replaced or
 * skipped. `sections` limits it (hosts, users, tokens, rules, channels, clients, dismissals, config).
 * Also open to an admin who hasn't replaced the initial password yet, so a fresh install can start
 * from an export.
 */
export const POST = handle(async (req: NextRequest) => {
  if (authEnabled()) requireAdmin(req);
  const body = await readBody<{ file?: unknown; passphrase?: unknown; sections?: unknown; dry_run?: unknown }>(req);
  const passphrase = typeof body.passphrase === "string" && body.passphrase ? body.passphrase : null;
  const result = await importConfig(body.file, passphrase, body.sections, body.dry_run === true);
  if (!result.applied) return json(result);

  const { add, replace, skip } = result.counts;
  audit(req, {
    action: "config.import",
    detail: `from ${result.export.source ?? "another install"} (${result.export.app_version ?? "unknown version"}): ${add} added, ${replace} replaced, ${skip} skipped`,
  });
  // replacing your own account signs you out, as a password change on another device would
  const signedOut = authEnabled() && !readSession(req.cookies.get(SESSION_COOKIE)?.value);
  return json({ ...result, signed_out: signedOut });
});
