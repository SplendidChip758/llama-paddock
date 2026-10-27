import { handle, json, listJobs } from "@/lib/server";

export const dynamic = "force-dynamic";

export const GET = handle(async () => json({ jobs: listJobs() }));
