// The agent protocol: which agents this dashboard can talk to, independent of release numbers.
// Shared by the server and the browser.

/**
 * The agent protocols this dashboard supports. Raise `max` once the dashboard has learned a new
 * protocol, and `min` only when it drops an old one (a breaking change: older agents stop working).
 * Every protocol keeps `version` and `protocol` in /health and /stats, so a dashboard can always
 * tell what it is talking to.
 */
export const AGENT_PROTOCOL = { min: 1, max: 1 } as const;

/** What to update so an agent and this dashboard work together; null: they already do. */
export type AgentIncompatible = "update-agent" | "update-dashboard";

/** The protocol an agent reports. Agents before it was added (0.9.0 and older) speak protocol 1. */
export function agentProtocol(reported: unknown): number {
  return typeof reported === "number" && Number.isInteger(reported) && reported >= 0 ? reported : 1;
}

export function protocolCompat(protocol: number): AgentIncompatible | null {
  if (protocol < AGENT_PROTOCOL.min) return "update-agent";
  if (protocol > AGENT_PROTOCOL.max) return "update-dashboard";
  return null;
}

export function supportedProtocols(): string {
  const { min, max } = AGENT_PROTOCOL;
  return min === max ? `${min}` : `${min} to ${max}`;
}

/** Why the dashboard stopped using an agent, and what fixes it. */
export function incompatibleText(protocol: number, why: AgentIncompatible): string {
  const fix = why === "update-agent" ? "update the agent" : "update the dashboard";
  return `incompatible: it speaks protocol ${protocol}, but this dashboard supports ${supportedProtocols()}; ${fix}`;
}
