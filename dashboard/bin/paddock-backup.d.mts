// Types for the part of paddock-backup.mjs that the dashboard imports (lib/configExport.ts).
export function backup(opts?: { reason?: string; keep?: number | string; dir?: string; version?: string | null }): {
  name: string;
  path: string;
  pruned: string[];
  warning: string | null;
};
