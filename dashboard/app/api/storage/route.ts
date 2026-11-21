import { handle, json } from "@/lib/server";
import { storageFailures } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** What the dashboard is failing to save to paddock.db right now; empty when every write works. */
export const GET = handle(async () => json({ failures: storageFailures() }));
