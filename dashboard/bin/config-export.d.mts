// Types for config-export.mjs, which the dashboard imports from lib/configExport.ts.
export const FORMAT: number;
export const MIN_PASSPHRASE: number;
export const SECTIONS: readonly ImportSection[];

export type ImportSection = "hosts" | "users" | "tokens" | "rules" | "channels" | "clients" | "dismissals" | "config";
export type ImportAction = "add" | "replace" | "skip";

export interface ImportItem {
  section: ImportSection;
  key: string;
  label: string;
  action: ImportAction;
  reason: string | null;
}

export interface ImportPlan {
  items: ImportItem[];
  writes: Record<string, unknown>;
  configText: string | null;
}

export interface ExportInfo {
  app_version: string | null;
  created: string | null;
  source: string | null;
  encrypted: boolean;
}

export type ExportConfig = Record<string, unknown>;
export type ExportFile = Record<string, unknown>;

interface Paths {
  dataDir: string;
  configPath: string;
}

export function collect(paths: Paths): ExportConfig;
export function buildExport(config: ExportConfig, opts: { passphrase: string | null; appVersion: string | null }): ExportFile;
export function isEncrypted(file: unknown): boolean;
export function inspect(file: unknown): ExportInfo;
export function openExport(file: unknown, passphrase: string | null | undefined): ExportConfig;
export function planImport(
  config: ExportConfig,
  opts: Paths & { sections?: readonly string[]; configIds?: string[]; currentRules?: unknown[] | null; writeConfig?: boolean },
): ImportPlan;
export function applyImport(plan: ImportPlan, opts: Paths & { chown?: (file: string) => void }): string[];
export function summarize(items: ImportItem[]): Record<ImportAction, number>;
