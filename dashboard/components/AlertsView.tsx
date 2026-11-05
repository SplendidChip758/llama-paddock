"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api, fmtDur } from "@/lib/format";
import { ALERT_KINDS, DEFAULT_CLEAR_S, durText, parseDur, subjectText, thresholdText } from "@/lib/rules";
import type { AlertKind, AlertRule, AlertSilence, AlertTransition, NotifyChannel } from "@/lib/types";
import { AlertLine, silenceChip, useSilences, whenText } from "./AlertBits";
import { ChannelsSection } from "./ChannelsSection";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

export function AlertsView({ host: hostFilter }: { host?: string }) {
  const { alerts, alertsStoreError, instances, toast, readOnly } = usePaddock();
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [channels, setChannels] = useState<NotifyChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // index into rules, or "new"
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([
        api<{ rules: AlertRule[] }>("/api/alerts/rules"),
        api<{ channels: NotifyChannel[] }>("/api/alerts/channels"),
      ]);
      setRules(r.rules);
      setChannels(c.channels);
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
  const notifyText = (r: AlertRule) => {
    if (r.channels == null) return channels?.length ? <span className="faint">all channels</span> : <span className="faint">no channels yet</span>;
    if (!r.channels.length) return <span className="faint">dashboard only</span>;
    return r.channels.map((id) => channels?.find((c) => c.id === id)?.name ?? `${id} (deleted)`).join(", ");
  };
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
        {!readOnly && <button className="btn primary" onClick={() => setEditing("new")} disabled={!rules}>Add rule</button>}
      </div>

      {alertsStoreError && (
        <div className="notice warn">
          Saving alert changes failed ({alertsStoreError}). Alerts still fire and resolve, but a dashboard restart may lose track of them.
        </div>
      )}

      <div className="card">
        {alerts.length ? (
          <div className="alertlist">
            {alerts.map((a) => <AlertLine key={`${a.rule}/${a.instance}/${a.subject}`} a={a} host={hostName(a.instance)} actions={!readOnly} />)}
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
                  <tr><th>On</th><th>Rule</th><th>Condition</th><th>Hosts</th><th>Notify</th><th /></tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={r.id} className={r.enabled ? "" : "off"}>
                      <td>
                        <input type="checkbox" checked={r.enabled} disabled={busy || readOnly} aria-label={`${r.enabled ? "Disable" : "Enable"} ${r.name}`}
                          onChange={() => save(rules.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)),
                            `${r.enabled ? "Disabled" : "Enabled"} ${r.name}`)} />
                      </td>
                      <td><b>{r.name}</b><div className="faint" style={{ fontSize: 12 }}>{ALERT_KINDS[r.kind].label}</div></td>
                      <td>{conditionText(r)}</td>
                      <td>{r.hosts ? r.hosts.map(hostName).join(", ") : <span className="faint">all hosts</span>}</td>
                      <td>{notifyText(r)}</td>
                      <td>
                        <div className="actions">
                          {!readOnly && <button className="btn sm" onClick={() => setEditing(i)}>Edit</button>}
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

      <ChannelsSection channels={channels} onSaved={setChannels} />
      <Silences rules={rules ?? []} hostName={hostName} />
      <History hostName={hostName} initialHost={hostFilter} />

      {editing !== null && rules && (
        <RuleEditor
          rule={editing === "new" ? undefined : rules[editing]}
          channels={channels ?? []}
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

/** Silences and acknowledgements in force, with what each one covers. */
function Silences({ rules, hostName }: { rules: AlertRule[]; hostName: (id: string) => string }) {
  const { alerts, readOnly } = usePaddock();
  const [list, setList] = useState<AlertSilence[] | null>(null);
  const { busy, end } = useSilences();
  // refetch whenever the alert list changes: silences come and go with it
  useEffect(() => {
    api<{ silences: AlertSilence[] }>("/api/alerts/silences").then((d) => setList(d.silences)).catch(() => setList([]));
  }, [alerts]);
  if (!list?.length) return null;
  const ruleName = (id: string) => rules.find((r) => r.id === id)?.name ?? id;
  return (
    <div className="section">
      <h2>Silences</h2>
      <div className="card">
        <div className="alertlist">
          {list.map((s) => (
            <div key={s.id} className="alertline">
              <div className="grow">
                <div>
                  <b>{s.rule ? ruleName(s.rule) : "Every rule"}</b> <span className="faint">on</span> {s.instance ? hostName(s.instance) : "every host"}
                  {s.subject && <span className="faint"> · {subjectText(s.subject)}</span>}
                </div>
                {s.note && <div className="hint" style={{ marginTop: 2 }}>{s.note}</div>}
              </div>
              <div className="chips" style={{ justifyContent: "flex-end", alignItems: "center" }}>
                <span className="chip">{silenceChip(s).text}</span>
                {!readOnly && <button className="btn sm" disabled={busy} onClick={() => end(s.id, "Silence ended")}>End</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Episode {
  key: string;
  rule: string;
  name: string;
  instance: string;
  subject: string;
  /** null: it fired before the oldest transition kept */
  fired: number | null;
  /** null: still firing */
  resolved: number | null;
  detail: string;
  flapping: boolean;
}

/** Pair firing and resolved transitions into episodes, newest first. */
function episodes(list: AlertTransition[]): Episode[] {
  const open = new Map<string, Episode>();
  const out: Episode[] = [];
  for (const t of list) {
    const key = `${t.rule}/${t.instance}/${t.subject}`;
    if (t.state === "firing") {
      const e: Episode = { key: `${key}/${t.id}`, rule: t.rule, name: t.name, instance: t.instance, subject: t.subject, fired: t.t, resolved: null, detail: t.detail, flapping: t.flapping };
      open.set(key, e);
      out.push(e);
    } else {
      const e = open.get(key);
      if (e) {
        e.resolved = t.t;
        open.delete(key);
      } else out.push({ key: `${key}/${t.id}`, rule: t.rule, name: t.name, instance: t.instance, subject: t.subject, fired: null, resolved: t.t, detail: t.detail, flapping: t.flapping });
    }
  }
  return out.sort((a, b) => (b.fired ?? b.resolved!) - (a.fired ?? a.resolved!));
}

const HISTORY_SHOWN = 100;

/** Alerts that fired and resolved, from the stored transitions. */
function History({ hostName, initialHost }: { hostName: (id: string) => string; initialHost?: string }) {
  const { instances, alerts } = usePaddock();
  const [list, setList] = useState<AlertTransition[] | null>(null);
  const [host, setHost] = useState(initialHost ?? "");
  useEffect(() => {
    api<{ transitions: AlertTransition[] }>("/api/alerts/transitions?limit=1000").then((d) => setList(d.transitions)).catch(() => setList([]));
  }, [alerts]);
  const all = useMemo(() => (list ? episodes(list) : []), [list]);
  const shown = all.filter((e) => !host || e.instance === host);
  return (
    <div className="section">
      <div className="card-head">
        <h2>History</h2>
        <select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host" style={{ width: "auto", maxWidth: 240 }}>
          <option value="">All hosts</option>
          {instances.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          {host && !instances.some((i) => i.id === host) && <option value={host}>{host}</option>}
        </select>
      </div>
      <div className="card">
        {list === null ? (
          <div className="empty">Loading…</div>
        ) : !shown.length ? (
          <div className="empty">No alerts have fired{host ? ` on ${hostName(host)}` : ""} in the kept history.</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Alert</th><th>Fired</th><th>Resolved</th><th>Lasted</th></tr>
              </thead>
              <tbody>
                {shown.slice(0, HISTORY_SHOWN).map((e) => (
                  <tr key={e.key}>
                    <td>
                      <b>{e.name}</b> <span className="faint">on</span> {hostName(e.instance)}
                      {e.subject && <span className="faint"> · {subjectText(e.subject)}</span>}
                      {e.flapping && <span className="chip warn" style={{ marginLeft: 6 }}>flapping</span>}
                      <div className="hint" style={{ marginTop: 2 }}>{e.detail}</div>
                    </td>
                    <td className="mono">{e.fired ? whenText(e.fired) : "earlier"}</td>
                    <td className="mono">{e.resolved ? whenText(e.resolved) : <span className="chip bad">firing</span>}</td>
                    <td className="mono">{e.fired ? fmtDur((e.resolved ?? Date.now() / 1000) - e.fired) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {shown.length > HISTORY_SHOWN && <div className="hint" style={{ marginTop: 8 }}>The latest {HISTORY_SHOWN} are shown; the API has them all.</div>}
    </div>
  );
}

function conditionText(r: AlertRule) {
  const unit = ALERT_KINDS[r.kind].unit;
  const what = unit ? `above ${thresholdText(r.threshold, unit)}` : "when it happens";
  return `${what}${r.for_s ? ` for ${durText(r.for_s)}` : ""} · clears after ${durText(r.clear_s)}`;
}

function RuleEditor({ rule, channels, busy, onClose, onSave, onDelete }: {
  rule?: AlertRule;
  channels: NotifyChannel[];
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
  const [allChannels, setAllChannels] = useState(rule?.channels == null);
  const [chosen, setChosen] = useState<string[]>(rule?.channels ?? []);
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
      channels: allChannels ? null : chosen,
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
            <input type="number" min={1} max={info.max ?? (info.unit === "%" ? 100 : 150)} step="any" value={threshold}
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

        <div className="field">
          <span className="fieldlabel">Notify</span>
          <label className="row hint" style={{ gap: 6, marginTop: 0 }}>
            <input type="checkbox" checked={allChannels} onChange={(e) => setAllChannels(e.target.checked)} /> Every channel, including ones added later
          </label>
          {!allChannels && (
            <div className="hostpick">
              {[...channels.map((c) => ({ id: c.id, name: c.name })), ...chosen.filter((id) => !channels.some((c) => c.id === id)).map((id) => ({ id, name: `${id} (deleted)` }))].map((c) => (
                <label key={c.id} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={chosen.includes(c.id)}
                    onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} />
                  {c.name}
                </label>
              ))}
              <div className="hint">{chosen.length ? "" : "None chosen: the alert only shows in the dashboard."}</div>
            </div>
          )}
          {!channels.length && <div className="hint">No channels yet: add one under Notifications on this page.</div>}
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
