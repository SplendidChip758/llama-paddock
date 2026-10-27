"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/format";

export function LoginForm({ next }: { next: string }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ must_change: boolean }>("/api/auth/login", { method: "POST", body: { username, password } });
      // full navigation so the app starts fresh with the new session cookie
      window.location.assign(r.must_change ? "/change-password" : next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <h1>Sign in</h1>
      {error && <div className="notice bad">{error}</div>}
      <label className="field">
        <span>Username</span>
        <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" autoComplete="current-password" autoFocus value={password}
          onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <button className="btn primary wide" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <div className="hint authfoot">
        The first password is printed by the installer (or in the container log). Forgot it? Delete <code>auth.json</code> in
        the data directory and restart.
      </div>
    </form>
  );
}

interface Me {
  auth: boolean;
  username?: string;
  must_change?: boolean;
  min_password?: number;
}

export function ChangePasswordForm() {
  const [me, setMe] = useState<Me | null>(null);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch((e) => setError(e.message));
  }, []);

  const min = me?.min_password ?? 8;
  const forced = !!me?.must_change;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < min) return setError(`Use at least ${min} characters.`);
    if (password !== confirm) return setError("The two new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/password", { method: "POST", body: { current, password } });
      window.location.assign("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };

  if (!me && !error) return <div className="empty">Loading…</div>;

  return (
    <form onSubmit={submit}>
      <h1>{forced ? "Choose a new password" : "Change password"}</h1>
      {forced && (
        <p className="sub">
          You signed in with the initial password. Pick your own before continuing. It will be required from now on.
        </p>
      )}
      {error && <div className="notice bad">{error}</div>}
      {/* lets password managers attach the new password to the right account */}
      <input type="text" autoComplete="username" value={me?.username ?? ""} readOnly hidden />
      {!forced && (
        <label className="field">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
      )}
      <label className="field">
        <span>New password</span>
        <input type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} required />
        <div className="hint">At least {min} characters.</div>
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      <button className="btn primary wide" type="submit" disabled={busy}>
        {busy ? "Saving…" : forced ? "Set password and continue" : "Change password"}
      </button>
      <div className="authfoot row" style={{ justifyContent: "space-between" }}>
        {forced ? <span /> : <Link className="ghost sm" href="/">Cancel</Link>}
        <button type="button" className="ghost sm" onClick={signOut}>Sign out</button>
      </div>
    </form>
  );
}
