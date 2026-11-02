import { activeAlerts } from "@/lib/alerts";
import { handle, json, paddock } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Alerts that are firing or pending, and whether transitions failed to save. */
export const GET = handle(async () => {
  // starts the poller, which evaluates the rules, if nothing else has yet
  paddock();
  return json(activeAlerts());
});
