// Shared by the server route (validation) and the client view (tab bar).
export const TABS = [
  ["monitor", "Monitor"],
  ["models", "Models"],
  ["env", "Environment"],
  ["logs", "Logs"],
] as const;

export type Tab = (typeof TABS)[number][0];

export const isTab = (t: string): t is Tab => TABS.some(([k]) => k === t);
