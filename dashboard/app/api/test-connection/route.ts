import { handle, json, readBody, testConnection } from "@/lib/server";
import type { InstanceInput } from "@/lib/config";

export const dynamic = "force-dynamic";

export const POST = handle(async (req: Request) => json(await testConnection(await readBody<InstanceInput & { id?: unknown }>(req))));
