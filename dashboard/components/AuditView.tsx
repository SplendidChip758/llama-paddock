"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/format";
import { AUDIT_ACTIONS, AUDIT_GROUPS, type AuditAction, type AuditEntry } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { whenText } from "./AlertBits";

interface AuditPage {
  entries: AuditEntry[];
  next: number | null;
  users: string[];
  instances: { id: string; name: string | null }[];
}

const PAGE = 100;

const FILTER = { width: "auto", minWidth: 0, maxWidth: "100%" } as const;

/** Actions under their group, for the Action filter. */
const GROUPED = Object.entries(AUDIT_GROUPS).map(([group, label]) => ({
  group, label, actions: (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter((a) => a.startsWith(`${group}.`)),
}));

export function AuditView() {
  const { me } = usePaddock();
  const [user, setUser] = useState("");
  const [instance, setInstance] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState<AuditPage | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback((before?: number) => {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (user) q.set("user", user);
    if (instance) q.set("instance", instance);
    if (action) q.set("action", action);
    if (before) q.set("before", String(before));
    return api<AuditPage>(`/api/audit?${q}`);
  }, [user, instance, action]);

  useEffect(() => {
    let live = true;
    query()
      .then((p) => {
        if (!live) return;
        setPage(p);
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [query]);

  const loadMore = async () => {
    if (!page?.next) return;
    setMore(true);
    try {
      const p = await query(page.next);
      setPage({ ...p, entries: [...page.entries, ...p.entries] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMore(false);
    }
  };

  if (!me) return <div className="empty">Loading…</div>;
  if (me.auth && me.role !== "admin") {
    return (
      <>
        <div className="pagehead"><h1>Audit log</h1></div>
        <div className="notice">Only admins can see the audit log.</div>
      </>
    );
  }

  const filtered = !!(user || instance || action);
  const entries = page?.entries ?? [];

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Audit log</h1>
          <div className="sub">Who changed what, and when. Prompts, passwords, tokens and environment values are never recorded.</div>
        </div>
      </div>

      {!me.auth && (
        <div className="notice">
          The dashboard&apos;s login is off (<code>PADDOCK_AUTH=off</code>), so changes are recorded with the client address but no user.
        </div>
      )}
      {error && <div className="notice bad">{error}</div>}

      <div className="row" style={{ flexWrap: "wrap", marginBottom: 14 }}>
        <select value={user} onChange={(e) => setUser(e.target.value)} aria-label="Filter by user" style={FILTER}>
          <option value="">All users</option>
          {page?.users.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        <select value={instance} onChange={(e) => setInstance(e.target.value)} aria-label="Filter by host" style={FILTER}>
          <option value="">All hosts</option>
          {page?.instances.map((i) => <option key={i.id} value={i.id}>{i.name ?? i.id}</option>)}
        </select>
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" style={FILTER}>
          <option value="">All actions</option>
          {GROUPED.map((g) => (
            <optgroup key={g.group} label={g.label}>
              <option value={g.group}>All {g.label.toLowerCase()}</option>
              {g.actions.map((a) => <option key={a} value={a}>{AUDIT_ACTIONS[a]}</option>)}
            </optgroup>
          ))}
        </select>
        {filtered && (
          <button className="ghost sm" onClick={() => { setUser(""); setInstance(""); setAction(""); }}>Clear filters</button>
        )}
      </div>

      <div className="card">
        {page === null ? (
          <div className="empty">{error ? "Couldn't load the audit log." : "Loading…"}</div>
        ) : !entries.length ? (
          <div className="empty">{filtered ? "Nothing matches these filters." : "Nothing recorded yet."}</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Time</th><th>Who</th><th>Action</th><th>Host</th><th>Target</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="mono" style={{ whiteSpace: "nowrap" }} title={new Date(e.t * 1000).toISOString()}>{whenText(e.t)}</td>
                    <td>
                      {e.user ? <b>{e.user}</b> : <span className="faint">{me.auth ? "unknown" : "—"}</span>}
                      {e.credential && <div className="hint" title={`token ${e.credential_id}`}>via token {e.credential}</div>}
                      {e.ip && <div className="hint mono">{e.ip}</div>}
                    </td>
                    <td className={e.action === "auth.login_failed" ? "bad-text" : ""}>{AUDIT_ACTIONS[e.action] ?? e.action}</td>
                    <td>{e.instance ? (e.instance_name ?? e.instance) : <span className="faint">–</span>}</td>
                    <td className="mono">{e.target ?? <span className="faint">–</span>}</td>
                    <td className="sub" style={{ minWidth: 220, maxWidth: 420, overflowWrap: "break-word" }}>{e.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {page?.next && (
        <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
          <button className="btn sm" disabled={more} onClick={loadMore}>{more ? "Loading…" : "Older entries"}</button>
        </div>
      )}
    </>
  );
}
