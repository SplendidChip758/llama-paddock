"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, fmtDur } from "@/lib/format";
import { subjectText } from "@/lib/rules";
import type { ActiveAlert, AlertSilence } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Popover } from "./ui";

/** How long "Silence for…" offers, in seconds. */
export const SILENCE_CHOICES: [string, number][] = [["1 hour", 3600], ["8 hours", 8 * 3600], ["1 day", 86400], ["7 days", 7 * 86400]];

/** "Mon 14:05", with the date when it isn't this week. */
export function whenText(t: number): string {
  const d = new Date(t * 1000);
  const week = Math.abs(Date.now() - d.getTime()) < 6 * 86400_000;
  return d.toLocaleString(undefined, week
    ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Firing alerts nobody has silenced: what the header and host badges count. */
export const loudAlerts = (alerts: ActiveAlert[]) => alerts.filter((a) => a.state === "firing" && !a.silence);

/** Silence, acknowledge and end silences, with toasts; the alert list refreshes after each. */
export function useSilences() {
  const { refreshInstances, toast } = usePaddock();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, "ok");
      await refreshInstances();
      return true;
    } catch (e) {
      toast((e as Error).message, "bad");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    silence: (body: Record<string, unknown>, ok: string) => run(() => api("/api/alerts/silences", { method: "POST", body }), ok),
    end: (id: number, ok: string) => run(() => api(`/api/alerts/silences/${id}`, { method: "DELETE" }), ok),
  };
}

export function silenceChip(s: AlertSilence) {
  if (s.until_resolved) return { text: "acknowledged", title: "Acknowledged: muted until it resolves" };
  return { text: `silenced until ${whenText(s.until!)}`, title: s.note ? `Silenced: ${s.note}` : "Silenced: still shown, but not counted or sent" };
}

/** A "Silence for…" menu that calls `pick` with the chosen seconds. */
export function SilenceMenu({ label, busy, pick }: { label: string; busy: boolean; pick: (seconds: number) => void }) {
  return (
    <select className="btn sm" value="" disabled={busy} aria-label={label}
      onChange={(e) => e.target.value && pick(Number(e.target.value))}>
      <option value="">{label}</option>
      {SILENCE_CHOICES.map(([text, s]) => <option key={s} value={s}>{text}</option>)}
    </select>
  );
}

/** One active alert. With `actions`, it can be acknowledged or silenced. */
export function AlertLine({ a, host, actions }: { a: ActiveAlert; host: string; actions?: boolean }) {
  const { busy, silence, end } = useSilences();
  const now = Date.now() / 1000;
  const cls = a.state === "firing" ? "bad" : "warn";
  const what = `${a.name} on ${host}${a.subject ? ` · ${subjectText(a.subject)}` : ""}`;
  const chip = a.silence && silenceChip(a.silence);
  // ending a silence that covers more than this alert (a whole host or rule) asks first
  const wide = a.silence && (a.silence.rule === null || a.silence.instance === null || a.silence.subject === null);
  const unsilence = () => {
    if (wide && !confirm(`This silence also covers other alerts${a.silence!.instance === null ? "" : ` on ${host}`}. End it?`)) return;
    end(a.silence!.id, a.silence!.until_resolved ? `${what}: no longer acknowledged` : "Silence ended");
  };
  return (
    <div className={`alertline ${a.silence ? "muted" : ""}`}>
      <span className={`dot ${a.unknown || a.silence ? "" : cls}`} />
      <div className="grow">
        <div>
          <b>{a.name}</b> <span className="faint">on</span>{" "}
          <Link href={`/i/${encodeURIComponent(a.instance)}/monitor`}>{host}</Link>
          {a.subject && <span className="faint"> · {subjectText(a.subject)}</span>}
        </div>
        <div className="hint" style={{ marginTop: 2 }}>{a.detail}</div>
      </div>
      <div className="chips" style={{ justifyContent: "flex-end", alignItems: "center" }}>
        {chip && <span className="chip" title={chip.title}>{chip.text}</span>}
        {a.unknown && <span className="chip" title="The last poll had no data for this alert, so it can't resolve yet">no data</span>}
        {a.flapping && <span className="chip warn" title="Fired repeatedly in a short time; it has to stay clear longer before it resolves">flapping</span>}
        <span className={`chip ${cls}`} title={new Date((a.fired_at ?? a.since) * 1000).toLocaleString()}>
          {a.state} {fmtDur(now - (a.fired_at ?? a.since))}
        </span>
        {actions && (a.silence ? (
          <button className="btn sm" onClick={unsilence} disabled={busy}>{a.silence.until_resolved ? "Unacknowledge" : "End silence"}</button>
        ) : (
          <>
            {a.state === "firing" && (
              <button className="btn sm" disabled={busy} title="Mute it until it resolves"
                onClick={() => silence({ rule: a.rule, instance: a.instance, subject: a.subject, until_resolved: true }, `Acknowledged ${what}`)}>
                Acknowledge
              </button>
            )}
            <SilenceMenu label="Silence for…" busy={busy}
              pick={(s) => silence({ rule: a.rule, instance: a.instance, subject: a.subject, duration_s: s }, `Silenced ${what}`)} />
          </>
        ))}
      </div>
    </div>
  );
}

/** "Silence host for…" on a host's page, for maintenance, or the silence in force with a way to end it. */
export function HostSilence({ id, name }: { id: string; name: string }) {
  const { alerts, readOnly } = usePaddock();
  const { busy, silence, end } = useSilences();
  const [current, setCurrent] = useState<AlertSilence | null>(null);
  useEffect(() => {
    api<{ silences: AlertSilence[] }>("/api/alerts/silences")
      .then((d) => setCurrent(d.silences.find((s) => s.instance === id && s.rule === null && s.subject === null) ?? null))
      .catch(() => {});
    // alerts change whenever a silence does, since each one carries its silence
  }, [alerts, id, busy]);
  if (current) {
    return (
      <span className="row" style={{ gap: 6 }}>
        <span className="chip" title={current.note || undefined}>alerts silenced until {whenText(current.until!)}</span>
        {!readOnly && <button className="btn sm" disabled={busy} onClick={() => end(current.id, `Alerts on ${name} are no longer silenced`)}>End</button>}
      </span>
    );
  }
  if (readOnly) return null;
  return (
    <SilenceMenu label="Silence host for…" busy={busy}
      pick={(s) => silence({ instance: id, duration_s: s, note: "maintenance" }, `Silenced alerts on ${name}`)} />
  );
}

/** How long the pill pulses when another alert fires. */
const PULSE_MS = 4000;

/**
 * A host's active alerts as a pill next to its name, opening the list with its actions: they don't
 * push the page down. Red while any is firing and not silenced; it pulses briefly when another fires.
 */
export function HostAlertPill({ id, name }: { id: string; name: string }) {
  const { alerts } = usePaddock();
  const mine = alerts.filter((a) => a.instance === id);
  const loud = loudAlerts(mine).length;
  const [pulse, setPulse] = useState(false);
  const seen = useRef(loud);
  useEffect(() => {
    const more = loud > seen.current;
    seen.current = loud;
    if (!more) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), PULSE_MS);
    return () => clearTimeout(t);
  }, [loud]);
  if (!mine.length) return null;
  const n = `${mine.length} alert${mine.length === 1 ? "" : "s"}`;
  return (
    <Popover className={`chip alertpill ${loud ? "bad" : ""} ${pulse ? "pulse" : ""}`} label={<><span className={`dot ${loud ? "bad" : ""}`} /> {n}</>}
      title={loud === mine.length ? undefined : `${loud} firing; the others are pending, silenced or acknowledged`}>
      <div className="row" style={{ marginBottom: 2 }}>
        <b className="grow">{n} on {name}</b>
        <Link href={`/alerts?host=${encodeURIComponent(id)}`} className="hint">All alerts and history →</Link>
      </div>
      <div className="alertlist">
        {mine.map((a) => <AlertLine key={`${a.rule}/${a.subject}`} a={a} host={name} actions />)}
      </div>
    </Popover>
  );
}
