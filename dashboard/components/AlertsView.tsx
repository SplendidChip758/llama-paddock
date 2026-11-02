"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, fmtDur } from "@/lib/format";
import { ALERT_KINDS, DEFAULT_CLEAR_S, durText, parseDur, subjectText } from "@/lib/rules";
import type { ActiveAlert, AlertKind, AlertRule } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

export function AlertsView() {
  const { alerts, alertsStoreError, instances, toast } = usePaddock();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // index into rules, or "new"
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules((await api<{ rules: AlertRule[] }>("/api/alerts/rules")).rules);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Store the whole list: the API replaces the rules. Returns false when it was refused. */
  const save = async (next: AlertRule[], msg: string) => {
    setBusy(true);
    try {
      setRules((await api<{ rules: AlertRule[] }>("/api/alerts/rules", { method: "PUT", body: { rules: next } })).rules);
      toast(msg, "ok");
      return true;
    } catch (e) {
      toast((e as Error).message, "bad");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const hostName = (id: string) => instances.find((i) => i.id === id)?.name ?? id;
  const firing = alerts.filter((a) => a.state === "firing");
  const pending = alerts.filter((a) => a.state === "pending");

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Alerts</h1>
          <div className="sub">
            {firing.length ? `${firing.length} firing` : "Nothing firing"}
            {pending.length ? ` · ${pending.length} pending` : ""} · rules are checked on every poll
          </div>
        </div>
        <button className="btn primary" onClick={() => setEditing("new")} disabled={!rules}>Add rule</button>
      </div>

      {alertsStoreError && (
        <div className="notice warn">
          Saving alert changes failed ({alertsStoreError}). Alerts still fire and resolve, but a dashboard restart may lose track of them.
        </div>
      )}

      <div className="card">
        {alerts.length ? (
          <div className="alertlist">
            {alerts.map((a) => <AlertLine key={`${a.rule}/${a.instance}/${a.subject}`} a={a} host={hostName(a.instance)} />)}
          </div>
        ) : (
          <div className="empty">No alerts. Hosts that match a rule show up here, first as pending until the rule&apos;s duration has passed.</div>
        )}
      </div>

      <div className="section">
        <h2>Rules</h2>
        {error && <div className="notice bad">{error}</div>}
        <div className="card">
          {rules === null ? (
            <div className="empty">Loading rules…</div>
          ) : rules.length === 0 ? (
            <div className="empty">No rules. Add one to be told when something goes wrong.</div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr><th>On</th><th>Rule</th><th>Condition</th><th>Hosts</th><th /></tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={r.id} className={r.enabled ? "" : "off"}>
                      <td>
                        <input type="checkbox" checked={r.enabled} disabled={busy} aria-label={`${r.enabled ? "Disable" : "Enable"} ${r.name}`}
                          onChange={() => save(rules.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)),
                            `${r.enabled ? "Disabled" : "Enabled"} ${r.name}`)} />
                      </td>
                      <td><b>{r.name}</b><div className="faint" style={{ fontSize: 12 }}>{ALERT_KINDS[r.kind].label}</div></td>
                      <td>{conditionText(r)}</td>
                      <td>{r.hosts ? r.hosts.map(hostName).join(", ") : <span className="faint">all hosts</span>}</td>
                      <td>
                        <div className="actions">
                          <button className="btn sm" onClick={() => setEditing(i)}>Edit</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          While a host doesn&apos;t report what a rule needs (its agent is down, a GPU is missing, or the dashboard wasn&apos;t
          running), that rule&apos;s alerts are unknown: they neither fire nor resolve until data comes back.
        </div>
      </div>

      {editing !== null && rules && (
        <RuleEditor
          rule={editing === "new" ? undefined : rules[editing]}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (r) => {
            const next = editing === "new" ? [...rules, r] : rules.map((x, j) => (j === editing ? r : x));
            if (await save(next, `Saved ${r.name}`)) setEditing(null);
          }}
          onDelete={editing === "new" ? undefined : async () => {
            const r = rules[editing];
            if (!confirm(`Delete the rule ${r.name}? Its firing alerts resolve.`)) return;
            if (await save(rules.filter((_, j) => j !== editing), `Deleted ${r.name}`)) setEditing(null);
          }}
        />
      )}
    </>
  );
}

function conditionText(r: AlertRule) {
  const unit = ALERT_KINDS[r.kind].unit;
  const what = unit ? `above ${r.threshold}${unit}` : "when it happens";
  return `${what}${r.for_s ? ` for ${durText(r.for_s)}` : ""} · clears after ${durText(r.clear_s)}`;
}

function AlertLine({ a, host }: { a: ActiveAlert; host: string }) {
  const now = Date.now() / 1000;
  const cls = a.state === "firing" ? "bad" : "warn";
  return (
    <div className="alertline">
      <span className={`dot ${a.unknown ? "" : cls}`} />
      <div className="grow">
        <div>
          <b>{a.name}</b> <span className="faint">on</span>{" "}
          <Link href={`/i/${encodeURIComponent(a.instance)}/monitor`}>{host}</Link>
          {a.subject && <span className="faint"> · {subjectText(a.subject)}</span>}
        </div>
        <div className="hint" style={{ marginTop: 2 }}>{a.detail}</div>
      </div>
      <div className="chips" style={{ justifyContent: "flex-end" }}>
        {a.unknown && <span className="chip" title="The last poll had no data for this alert, so it can't resolve yet">no data</span>}
        {a.flapping && <span className="chip warn" title="Fired repeatedly in a short time; it has to stay clear longer before it resolves">flapping</span>}
        <span className={`chip ${cls}`} title={new Date((a.fired_at ?? a.since) * 1000).toLocaleString()}>
          {a.state} {fmtDur(now - (a.fired_at ?? a.since))}
        </span>
      </div>
    </div>
  );
}

function RuleEditor({ rule, busy, onClose, onSave, onDelete }: {
  rule?: AlertRule;
  busy: boolean;
  onClose: () => void;
  onSave: (r: AlertRule) => void;
  onDelete?: () => void;
}) {
  const { instances } = usePaddock();
  const [kind, setKind] = useState<AlertKind>(rule?.kind ?? "gpu_temp");
  const info = ALERT_KINDS[kind];
  const [name, setName] = useState(rule?.name ?? "");
  const [threshold, setThreshold] = useState(String(rule?.threshold ?? info.threshold ?? ""));
  const [forText, setForText] = useState(durText(rule?.for_s ?? info.for_s).replace("at once", "0"));
  const [clearText, setClearText] = useState(durText(rule?.clear_s ?? DEFAULT_CLEAR_S).replace("at once", "0"));
  const [allHosts, setAllHosts] = useState(!rule?.hosts);
  const [hosts, setHosts] = useState<string[]>(rule?.hosts ?? []);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const forS = parseDur(forText);
  const clearS = parseDur(clearText);

  const changeKind = (k: AlertKind) => {
    setKind(k);
    // a new rule follows the kind's defaults; an existing one keeps what was set
    if (!rule) {
      setThreshold(String(ALERT_KINDS[k].threshold ?? ""));
      setForText(durText(ALERT_KINDS[k].for_s).replace("at once", "0"));
    }
  };

  // hosts a rule names that are no longer configured stay listed, so saving doesn't drop them silently
  const choices = [...instances.map((i) => ({ id: i.id, name: i.name })), ...hosts.filter((h) => !instances.some((i) => i.id === h)).map((h) => ({ id: h, name: `${h} (removed)` }))];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({
      id: rule?.id ?? "", name: name.trim() || info.label, kind, enabled,
      threshold: info.unit ? Number(threshold) : null,
      for_s: forS ?? -1, clear_s: clearS ?? -1,
      hosts: allHosts ? null : hosts,
    });
  };

  return (
    <Drawer open onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <div className="drawer-head">
          <h3>{rule ? `Edit ${rule.name}` : "Add rule"}</h3>
          <button type="button" className="ghost" onClick={onClose}>✕</button>
        </div>

        <label className="field">
          <span>Watch for</span>
          <select value={kind} onChange={(e) => changeKind(e.target.value as AlertKind)}>
            {(Object.keys(ALERT_KINDS) as AlertKind[]).map((k) => <option key={k} value={k}>{ALERT_KINDS[k].label}</option>)}
          </select>
          <div className="hint">{info.help}</div>
        </label>

        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={info.label} />
        </label>

        {info.unit && (
          <label className="field">
            <span>Threshold ({info.unit})</span>
            <input type="number" min={1} max={info.unit === "%" ? 100 : 150} step="any" value={threshold}
              onChange={(e) => setThreshold(e.target.value)} required />
            <div className="hint">Fires above this value.</div>
          </label>
        )}

        <div className="row" style={{ alignItems: "flex-start" }}>
          <label className="field grow">
            <span>For</span>
            <input type="text" value={forText} onChange={(e) => setForText(e.target.value)} placeholder="2m" />
            <div className="hint" style={forS === null ? { color: "var(--bad)" } : undefined}>
              {forS === null ? "Use seconds or 90s, 2m, 1h 30m." : `Fires once it has held for ${durText(forS)}.`}
            </div>
          </label>
          <label className="field grow">
            <span>Clear for</span>
            <input type="text" value={clearText} onChange={(e) => setClearText(e.target.value)} placeholder="1m" />
            <div className="hint" style={clearS === null ? { color: "var(--bad)" } : undefined}>
              {clearS === null ? "Use seconds or 90s, 2m, 1h 30m." : `Resolves once it has been clear for ${durText(clearS)}.`}
            </div>
          </label>
        </div>

        <div className="field">
          <span className="fieldlabel">Hosts</span>
          <label className="row hint" style={{ gap: 6, marginTop: 0 }}>
            <input type="checkbox" checked={allHosts} onChange={(e) => setAllHosts(e.target.checked)} /> Every host, including ones added later
          </label>
          {!allHosts && (
            <div className="hostpick">
              {choices.map((h) => (
                <label key={h.id} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={hosts.includes(h.id)}
                    onChange={(e) => setHosts(e.target.checked ? [...hosts, h.id] : hosts.filter((x) => x !== h.id))} />
                  {h.name}
                </label>
              ))}
              {!choices.length && <div className="hint">No hosts yet.</div>}
            </div>
          )}
        </div>

        <label className="row hint" style={{ gap: 6, marginBottom: 14 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>

        <div className="row" style={{ marginTop: 20 }}>
          {onDelete && <button type="button" className="danger" onClick={onDelete} disabled={busy}>Delete</button>}
          <span className="grow" />
          <button type="submit" className="btn primary"
            disabled={busy || forS === null || clearS === null || (!allHosts && !hosts.length)}>
            {busy ? "Saving…" : rule ? "Save" : "Add rule"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
