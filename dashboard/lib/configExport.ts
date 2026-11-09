// Configuration export and import from the dashboard (#87). The work is done by bin/config-export.mjs,
// which paddock-backup shares; this applies an import to the running dashboard.
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { version } from "@/package.json";
import {
  SECTIONS, applyImport, buildExport, collect, inspect, openExport, planImport, summarize,
  type ExportInfo, type ImportItem,
} from "@/bin/config-export.mjs";
import { listRules, reloadRules } from "./alerts";
import { HttpError } from "./http-error";
import { reloadChannels } from "./notify";
import { paddock, reloadHosts } from "./server";
import { dataDir } from "./store";

type Backup = typeof import("@/bin/paddock-backup.mjs").backup;

/**
 * paddock-backup.mjs is loaded from bin/ next to server.js, not bundled: it is a CLI full of paths
 * the bundler can't follow. next.config.ts has it traced into the standalone output.
 */
async function takeBackup(...args: Parameters<Backup>) {
  const file = path.join(/*turbopackIgnore: true*/ process.cwd(), "bin/paddock-backup.mjs");
  const mod = (await import(/*webpackIgnore: true*/ /*turbopackIgnore: true*/ pathToFileURL(file).href)) as { backup: Backup };
  return mod.backup(...args);
}

const paths = () => ({ dataDir: dataDir(), configPath: process.env.PADDOCK_CONFIG || "/config/config.yaml" });

/** Errors from the shared module are about the file or the passphrase: the client's to fix. */
function asClientError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}

export function exportConfig(passphrase: string | null) {
  const config = collect(paths());
  return asClientError(() => buildExport(config, { passphrase, appVersion: version }));
}

export interface ImportResult {
  export: ExportInfo;
  items: ImportItem[];
  counts: Record<"add" | "replace" | "skip", number>;
  applied: boolean;
  /** Changed files in the data directory, or config.yaml */
  written: string[];
}

export async function importConfig(file: unknown, passphrase: string | null, sections: unknown, dryRun: boolean): Promise<ImportResult> {
  const info = asClientError(() => inspect(file));
  const config = asClientError(() => openExport(file, passphrase));
  let only: string[] = [...SECTIONS];
  if (sections != null) {
    if (!Array.isArray(sections) || sections.some((s) => !SECTIONS.includes(s))) {
      throw new HttpError(400, `sections: a list of ${SECTIONS.join(", ")}`);
    }
    only = sections.map(String);
  }
  const p = paddock();
  const plan = asClientError(() =>
    planImport(config, {
      ...paths(),
      sections: only,
      configIds: [...p.instances.values()].filter((s) => s.inst.source === "config").map((s) => s.inst.id),
      currentRules: listRules(),
      // config.yaml is the operator's file, read-only in the UI as everywhere else
      writeConfig: false,
    }),
  );
  const result = { export: info, items: plan.items, counts: summarize(plan.items), applied: false, written: [] as string[] };
  if (dryRun) return result;

  // what an import replaces can be restored: the same pre-import backup the CLI takes
  if (plan.items.some((i) => i.action !== "skip") && fs.existsSync(/*turbopackIgnore: true*/ dataDir())) {
    try {
      await takeBackup({ reason: "pre-import", version });
    } catch (e) {
      throw new HttpError(500, `couldn't back up before importing, so nothing was changed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const written = applyImport(plan, paths());
  // auth.json, credentials.json and the dismissals are read again when they change; these are held in memory
  if (written.includes("hosts.json") || written.includes("agent-pins.json")) reloadHosts();
  if (written.includes("alert-rules.json")) reloadRules();
  if (written.includes("alert-channels.json")) reloadChannels();
  return { ...result, applied: true, written };
}
