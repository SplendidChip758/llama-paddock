import { handle, json, securityReport } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Every security check of the dashboard and each host, with how to fix the failing ones. */
export const GET = handle(async () => json(securityReport()));
