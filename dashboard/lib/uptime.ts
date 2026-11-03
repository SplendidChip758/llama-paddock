// A host's availability over a range, from the observed spans and events in paddock.db (#95). Time
// the dashboard wasn't polling is unobserved, and time it polled without seeing a service yet is
// unknown: neither counts as up or down, so a dashboard outage never lowers a host's uptime.
import "server-only";
import { eventHistory, type EventHistory, type HistoryRange } from "./db";
import type { Availability, AvailabilitySegment, HostAvailability } from "./types";

export const UPTIME_RANGES = ["24h", "7d", "30d"] as const;
export type UptimeRange = (typeof UPTIME_RANGES)[number];
export const isUptimeRange = (r: string | null): r is UptimeRange => (UPTIME_RANGES as readonly string[]).includes(r ?? "");

/** How close to the end of the range the last poll must be for an outage it saw to count as ongoing. */
const ONGOING_S = 60;

function track(h: EventHistory, kind: "ollama" | "agent"): Availability {
  const segments: AvailabilitySegment[] = [];
  const push = (start: number, end: number, state: AvailabilitySegment["state"], error?: string) => {
    if (end <= start) return;
    const last = segments[segments.length - 1];
    // a span that continues where the last one ended in the same state is one stretch
    if (last && last.state === state && start - last.end < 1) last.end = end;
    else segments.push({ start, end, state, ...(state === "down" && error ? { error } : {}) });
  };
  const events = h.events.filter((e) => e.kind === kind);
  let cursor = h.from;
  let i = 0;
  for (const span of h.observed) {
    push(cursor, span.start, "unobserved");
    // only the span that covers `from` starts with a known state; the others start unknown until their first events
    let up: boolean | null = span.start <= h.from && h.initial ? h.initial[kind] : null;
    let error: string | undefined;
    let at = span.start;
    while (i < events.length && events[i].t < span.start) i++;
    for (; i < events.length && events[i].t <= span.end; i++) {
      const e = events[i];
      push(at, e.t, up === null ? "unknown" : up ? "up" : "down", error);
      up = !!e.up;
      error = e.up ? undefined : e.error;
      at = Math.max(at, e.t);
    }
    push(at, span.end, up === null ? "unknown" : up ? "up" : "down", error);
    cursor = Math.max(cursor, span.end);
  }
  push(cursor, h.to, "unobserved");

  // an outage is still going on only if it is the last thing seen, at the last poll
  const lastSeen = segments.findLast((x) => x.state !== "unobserved");
  const sum = (state: AvailabilitySegment["state"]) => segments.filter((x) => x.state === state).reduce((s, x) => s + x.end - x.start, 0);
  const up_s = sum("up"), down_s = sum("down");
  return {
    up_pct: up_s + down_s > 0 ? Math.round((up_s / (up_s + down_s)) * 100_000) / 1000 : null,
    up_s: Math.round(up_s), down_s: Math.round(down_s), unknown_s: Math.round(sum("unknown")), unobserved_s: Math.round(sum("unobserved")),
    segments,
    outages: segments.filter((x) => x.state === "down").reverse()
      .map((x) => ({ start: x.start, end: x.end, error: x.error ?? null, ongoing: x === lastSeen && h.to - x.end < ONGOING_S })),
  };
}

export function hostAvailability(instance: string, range: UptimeRange, hasAgent: boolean): HostAvailability {
  const h = eventHistory(instance, range as HistoryRange, hasAgent);
  return { range, from: h.from, to: h.to, coverage: h.coverage, ollama: track(h, "ollama"), agent: hasAgent ? track(h, "agent") : null };
}
