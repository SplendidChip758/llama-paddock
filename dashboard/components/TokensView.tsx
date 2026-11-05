"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ago, api, untilText } from "@/lib/format";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

interface Token {
  id: string;
  kind: "api" | "display" | "gateway";
  name: string;
  scopes: string[];
  created: string;
  expires: string | null;
  last_used: string | null;
  expired: boolean;
  /** only when an admin lists everyone's */
  user?: string | null;
}

type Access = "read" | "write";

const ACCESS_SCOPES: Record<Access, string[]> = { read: ["api:read"], write: ["api:read", "api:write"] };
const ACCESS_HELP: Record<Access, string> = {
  read: "Reads the fleet, history, alerts and logs. Changes nothing.",
  write: "Everything an admin can do through the API, such as restarting Ollama or pulling models, except managing users and tokens.",
};

const accessLabel = (t: Token) =>
  t.kind !== "api" ? t.kind : t.scopes.includes("api:write") ? "read and write" : "read only";

export function TokensView() {
  const { me, toast } = usePaddock();
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // shown once, right after it is created
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens((await api<{ tokens: Token[] }>(all ? "/api/tokens?all=1" : "/api/tokens")).tokens);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [all]);

  useEffect(() => {
    if (me?.auth) load();
  }, [me?.auth, load]);

  const revoke = async (t: Token) => {
    const whose = t.user && t.user.toLowerCase() !== me?.username?.toLowerCase() ? ` (${t.user}'s)` : "";
    if (!confirm(`Revoke "${t.name}"${whose}? Anything using it stops working at once.`)) return;
    setBusy(t.id);
    try {
      await api(`/api/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      toast(`Revoked ${t.name}`, "ok");
      await load();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied", "ok");
    } catch {
      // http:// pages have no clipboard API; the token is selectable instead
      toast("Couldn't copy: select the token and copy it", "bad");
    }
  };

  if (!me) return <div className="empty">Loading…</div>;
  if (!me.auth) {
    return (
      <>
        <div className="pagehead"><h1>API tokens</h1></div>
        <div className="notice">
          The dashboard&apos;s login is off (<code>PADDOCK_AUTH=off</code>), so there are no tokens: whatever your auth proxy
          lets through can call the API. Turn the login on to give scripts their own revocable tokens.
        </div>
      </>
    );
  }

  const admin = me.role === "admin";

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>API tokens</h1>
          <div className="sub">
            For scripts, Home Assistant and cron jobs: send <code>Authorization: Bearer &lt;token&gt;</code>.
            A token can never do more than your account.
          </div>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>New token</button>
      </div>

      {fresh && (
        <div className="notice ok">
          <div className="row">
            <span className="grow">
              Token <b>{fresh.name}</b>:{" "}
              <span className="mono" style={{ userSelect: "all", wordBreak: "break-all" }}>{fresh.token}</span>
              <div className="hint">Copy it now and keep it somewhere safe. It isn&apos;t shown again.</div>
            </span>
            <button className="btn sm" onClick={() => copy(fresh.token)}>Copy</button>
            <button className="ghost sm" onClick={() => setFresh(null)} aria-label="Hide the new token">✕</button>
          </div>
        </div>
      )}
      {error && <div className="notice bad">{error}</div>}

      {admin && (
        <label className="row" style={{ marginBottom: 12, gap: 8 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          <span>Show every user&apos;s tokens</span>
        </label>
      )}

      <div className="card">
        {tokens === null ? (
          <div className="empty">{error ? "Couldn't load the tokens." : "Loading tokens…"}</div>
        ) : tokens.length === 0 ? (
          <div className="empty">No tokens yet.</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  {all && <th>User</th>}
                  <th>Access</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.name}</b> <span className="faint mono" title="Token id">{t.id.slice(0, 8)}</span></td>
                    {all && <td>{t.user ?? "–"}</td>}
                    <td><span className="chip" title={t.scopes.join(", ")}>{accessLabel(t)}</span></td>
                    <td>{ago(t.created)}</td>
                    <td>{t.last_used ? ago(t.last_used) : <span className="faint">never</span>}</td>
                    <td>
                      {t.expired
                        ? <span className="chip bad">expired</span>
                        : t.expires ? untilText(t.expires) : <span className="faint">never</span>}
                    </td>
                    <td>
                      <div className="actions">
                        <button className="danger sm" disabled={busy === t.id} onClick={() => revoke(t)}>Revoke</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && (
        <NewToken
          admin={admin}
          onClose={() => setAdding(false)}
          onCreated={(name, token) => {
            setAdding(false);
            setFresh({ name, token });
            load();
          }}
        />
      )}
    </>
  );
}

function NewToken({ admin, onClose, onCreated }: { admin: boolean; onClose: () => void; onCreated: (name: string, token: string) => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>("read");
  const [days, setDays] = useState("90");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ name: string; token: string }>("/api/tokens", {
        method: "POST",
        body: { name: name.trim(), kind: "api", scopes: ACCESS_SCOPES[access], expires_days: days ? Number(days) : null },
      });
      onCreated(r.name, r.token);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Drawer open onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <div className="drawer-head">
          <h3>New API token</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>Name</span>
          <input type="text" autoFocus required maxLength={64} value={name} placeholder="home-assistant" onChange={(e) => setName(e.target.value)} />
          <div className="hint">What uses it, so you know what breaks if you revoke it.</div>
        </label>
        <label className="field">
          <span>Access</span>
          <select value={access} onChange={(e) => setAccess(e.target.value as Access)}>
            <option value="read">Read only</option>
            {admin && <option value="write">Read and write</option>}
          </select>
          <div className="hint">{ACCESS_HELP[access]}</div>
        </label>
        <label className="field">
          <span>Expires</span>
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in a year</option>
            <option value="">never</option>
          </select>
        </label>
        <div className="hint">
          The token is shown once. If your role changes, the token loses whatever the new role can&apos;t do, for good.
          It is removed with your account.
        </div>
        <div className="row" style={{ marginTop: 20 }}>
          <span className="grow" />
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create token"}</button>
        </div>
      </form>
    </Drawer>
  );
}
