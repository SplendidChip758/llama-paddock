"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, copyText } from "@/lib/format";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

type Role = "admin" | "viewer";

interface User {
  username: string;
  role: Role;
  must_change: boolean;
}

const ROLE_HELP: Record<Role, string> = {
  admin: "Full control: hosts, models, settings, alerts and users.",
  viewer: "Sees everything, changes nothing.",
};

const userPath = (name: string, rest = "") => `/api/users/${encodeURIComponent(name)}${rest}`;

export function UsersView() {
  const { me, toast } = usePaddock();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // shown once, right after an account is created or its password reset
  const [handover, setHandover] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: User[] }>("/api/users")).users);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (me?.auth) load();
  }, [me?.auth, load]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
      await load();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const setRole = (u: User, role: Role) => run(u.username, async () => {
    await api(userPath(u.username), { method: "PUT", body: { role } });
    toast(`${u.username} is now ${role === "admin" ? "an admin" : "a viewer"}`, "ok");
  });

  const reset = (u: User) => {
    if (!confirm(`Reset ${u.username}'s password? They are signed out and need the new temporary password to sign in.`)) return;
    run(u.username, async () => {
      const r = await api<{ password: string }>(userPath(u.username, "/reset"), { method: "POST" });
      setHandover({ username: u.username, password: r.password });
    });
  };

  const remove = (u: User) => {
    if (!confirm(`Remove ${u.username}? They are signed out at once.`)) return;
    run(u.username, async () => {
      await api(userPath(u.username), { method: "DELETE" });
      if (handover?.username === u.username) setHandover(null);
      toast(`Removed ${u.username}`, "ok");
    });
  };

  if (!me) return <div className="empty">Loading…</div>;
  if (!me.auth) {
    return (
      <>
        <div className="pagehead"><h1>Users</h1></div>
        <div className="notice">
          The dashboard&apos;s login is off (<code>PADDOCK_AUTH=off</code>), so whoever your auth proxy lets in has full control.
          Turn the login on to give people their own accounts with admin or viewer roles.
        </div>
      </>
    );
  }

  const self = (u: User) => u.username.toLowerCase() === me.username?.toLowerCase();

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Users</h1>
          <div className="sub">Admins have full control. Viewers see everything but can&apos;t change anything.</div>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>Add user</button>
      </div>

      {handover && (
        <div className="notice ok">
          <div className="row">
            <span className="grow">
              Temporary password for <b>{handover.username}</b>:{" "}
              <span className="mono" style={{ userSelect: "all" }}>{handover.password}</span>
              <div className="hint">Pass it on privately. They choose their own when they first sign in. It isn&apos;t shown again.</div>
            </span>
            <button className="btn sm" onClick={async () => {
              if (await copyText(handover.password)) toast("Copied", "ok");
              else toast("Couldn't copy: select the password and copy it", "bad");
            }}>Copy</button>
            <button className="ghost sm" onClick={() => setHandover(null)} aria-label="Hide the temporary password">✕</button>
          </div>
        </div>
      )}
      {error && <div className="notice bad">{error}</div>}

      <div className="card">
        {users === null ? (
          <div className="empty">{error ? "Couldn't load the users." : "Loading users…"}</div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>User</th><th>Role</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username}>
                    <td><b>{u.username}</b>{self(u) && <span className="faint"> (you)</span>}</td>
                    <td>
                      {self(u) ? (
                        <span title="You can't change your own role">{u.role}</span>
                      ) : (
                        <select value={u.role} disabled={busy === u.username} aria-label={`Role of ${u.username}`}
                          onChange={(e) => setRole(u, e.target.value as Role)}>
                          <option value="admin">admin</option>
                          <option value="viewer">viewer</option>
                        </select>
                      )}
                    </td>
                    <td>
                      {u.must_change
                        ? <span className="chip warn" title="Signs in with a temporary password and must choose their own">temporary password</span>
                        : <span className="faint">active</span>}
                    </td>
                    <td>
                      {!self(u) && (
                        <div className="actions">
                          <button className="btn sm" disabled={busy === u.username} onClick={() => reset(u)}>Reset password</button>
                          <button className="danger sm" disabled={busy === u.username} onClick={() => remove(u)}>Remove</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && (
        <AddUser
          onClose={() => setAdding(false)}
          onAdded={(username, password) => {
            setAdding(false);
            setHandover({ username, password });
            load();
          }}
        />
      )}
    </>
  );
}

function AddUser({ onClose, onAdded }: { onClose: () => void; onAdded: (username: string, password: string) => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ username: string; password: string }>("/api/users", { method: "POST", body: { username: username.trim(), role } });
      onAdded(r.username, r.password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Drawer open onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <div className="drawer-head">
          <h3>Add user</h3>
          <button type="button" className="ghost" onClick={onClose}>✕</button>
        </div>
        {error && <div className="notice bad">{error}</div>}
        <label className="field">
          <span>Username</span>
          <input type="text" autoFocus required maxLength={64} value={username} onChange={(e) => setUsername(e.target.value)} />
          <div className="hint">Letters, digits and . _ @ -</div>
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">viewer</option>
            <option value="admin">admin</option>
          </select>
          <div className="hint">{ROLE_HELP[role]}</div>
        </label>
        <div className="hint">
          The dashboard makes a temporary password for you to pass on. The new user chooses their own when they first sign in.
        </div>
        <div className="row" style={{ marginTop: 20 }}>
          <span className="grow" />
          <button type="submit" className="btn primary" disabled={busy || !username.trim()}>{busy ? "Adding…" : "Add user"}</button>
        </div>
      </form>
    </Drawer>
  );
}
