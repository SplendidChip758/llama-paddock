"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/format";
import { usePaddock } from "./PaddockProvider";

type Section = "hosts" | "users" | "tokens" | "rules" | "channels" | "clients" | "dismissals" | "config";
type Action = "add" | "replace" | "skip";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "hosts", label: "Hosts" },
  { id: "users", label: "Users" },
  { id: "tokens", label: "API tokens" },
  { id: "rules", label: "Alert rules" },
  { id: "channels", label: "Alert channels" },
  { id: "clients", label: "Client names" },
  { id: "dismissals", label: "Security dismissals" },
  // the dashboard never writes config.yaml: the preview only says whether it differs
  { id: "config", label: "config.yaml (compare only)" },
];

/** Same as MIN_PASSPHRASE in bin/config-export.mjs. */
const MIN_PASSPHRASE = 12;

interface ImportResult {
  export: { app_version: string | null; created: string | null; source: string | null; encrypted: boolean };
  items: { section: Section; key: string; label: string; action: Action; reason: string | null }[];
  counts: Record<Action, number>;
  applied: boolean;
  signed_out?: boolean;
}

export function BackupView() {
  const { me } = usePaddock();
  if (!me) return <div className="empty">Loading…</div>;
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Backup</h1>
          <div className="sub">Move this dashboard&apos;s setup to another install, or bring one in.</div>
        </div>
      </div>
      <div className="notice">
        A configuration export holds the hosts with their agent tokens and Ollama keys, users, API tokens, alert rules and
        channels, client names, security dismissals and <code>config.yaml</code>. Metric history, jobs and the audit log stay
        here. To roll this install back after an update, use full backups (<code>paddock-backup backup</code>) instead.
      </div>
      <div className="grid g2">
        <ExportCard auth={me.auth} />
        <div className="card">
          <div className="card-head"><h3>Import</h3></div>
          <ImportForm />
        </div>
      </div>
    </>
  );
}

function ExportCard({ auth }: { auth: boolean }) {
  const { toast } = usePaddock();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [unencrypted, setUnencrypted] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!unencrypted && [...passphrase].length < MIN_PASSPHRASE) return setError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
    if (!unencrypted && passphrase !== confirm) return setError("The two passphrases don't match.");
    setBusy(true);
    setError(null);
    try {
      // a file, not JSON for the page: fetch it and hand it to the browser as a download
      const r = await fetch("/api/config/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unencrypted ? { unencrypted: true, password } : { passphrase, password }),
        cache: "no-store",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`);
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "llama-paddock-config.json";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setPassphrase("");
      setConfirm("");
      setPassword("");
      toast(`Exported ${name}`, "ok");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} autoComplete="off">
      <div className="card-head"><h3>Export</h3></div>
      {error && <div className="notice bad">{error}</div>}
      {!unencrypted && (
        <>
          <label className="field">
            <span>Passphrase</span>
            <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <div className="hint">At least {MIN_PASSPHRASE} characters. You need it to import the file; it can&apos;t be recovered.</div>
          </label>
          <label className="field">
            <span>Confirm passphrase</span>
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        </>
      )}
      <label className="row" style={{ marginBottom: 12, gap: 8 }}>
        <input type="checkbox" checked={unencrypted} onChange={(e) => setUnencrypted(e.target.checked)} />
        <span>Export unencrypted</span>
      </label>
      {unencrypted && (
        <div className="notice warn">
          The file will hold every agent token, Ollama key, alert channel secret and password hash in plain text. Anyone who
          gets it can reach your hosts. Keep it somewhere only you can read, and delete it once imported.
        </div>
      )}
      {auth && (
        <label className="field">
          <span>Your password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <div className="hint">The export holds every secret this dashboard keeps, so confirm it&apos;s you.</div>
        </label>
      )}
      <button className="btn primary" type="submit" disabled={busy}>{busy ? "Exporting…" : "Download export"}</button>
    </form>
  );
}

const ACTION_CHIP: Record<Action, string> = { add: "ok", replace: "warn", skip: "dim" };
const ACTION_TEXT: Record<Action, string> = { add: "add", replace: "replace", skip: "skip" };

/** Read an export, show what importing it would do, then do it. Also on the first-login screen of a fresh install. */
export function ImportForm({ setup = false }: { setup?: boolean }) {
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [sections, setSections] = useState<Set<Section>>(new Set(SECTIONS.map((s) => s.id)));
  const [plan, setPlan] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (f: File | undefined) => {
    setPlan(null);
    setDone(null);
    setError(null);
    if (!f) return setFile(null);
    try {
      setFile({ name: f.name, data: JSON.parse(await f.text()) });
    } catch {
      setFile(null);
      setError(`${f.name} isn't a llama-paddock configuration export.`);
    }
  };

  const send = (dryRun: boolean) =>
    api<ImportResult>("/api/config/import", {
      method: "POST",
      body: { file: file?.data, passphrase: passphrase || null, sections: [...sections], dry_run: dryRun },
    });

  const preview = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setPlan(await send(true));
    } catch (err) {
      setPlan(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await send(false);
      setPlan(null);
      setDone(r);
      // a replaced account of your own is signed out; after a setup import, start from the login
      if (r.signed_out) window.location.assign("/login");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (s: Section) => {
    setPlan(null);
    setSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const changes = plan ? plan.counts.add + plan.counts.replace : 0;

  return (
    <form onSubmit={preview} autoComplete="off">
      {error && <div className="notice bad">{error}</div>}
      {done && (
        <div className="notice ok">
          Imported: {done.counts.add} added, {done.counts.replace} replaced, {done.counts.skip} skipped.
          {setup && " Sign in again if your account was replaced, or choose your password below."}
        </div>
      )}
      <label className="field">
        <span>Export file</span>
        <input type="file" accept=".json,application/json" aria-label="Export file" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      <label className="field">
        <span>Passphrase</span>
        <input type="password" autoComplete="off" value={passphrase} onChange={(e) => { setPassphrase(e.target.value); setPlan(null); }} />
        <div className="hint">Leave it blank for an unencrypted export.</div>
      </label>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 14px" }}>
        <legend className="fieldlabel">Parts to import</legend>
        <div className="chips">
          {SECTIONS.map((s) => (
            <label key={s.id} className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={sections.has(s.id)} onChange={() => toggle(s.id)} />
              <span>{s.label}</span>
            </label>
          ))}
        </div>
        <div className="hint">Nothing here is removed: entries are added, or replaced when the same host, user or rule exists.</div>
      </fieldset>
      <button className="btn" type="submit" disabled={busy || !file || !sections.size}>{busy && !plan ? "Reading…" : "Preview import"}</button>

      {plan && (
        <div style={{ marginTop: 16 }}>
          <div className="hint" style={{ marginBottom: 8 }}>
            Exported {plan.export.created ? new Date(plan.export.created).toLocaleString() : ""} from{" "}
            {plan.export.source ?? "another install"} (llama-paddock {plan.export.app_version ?? "unknown version"}).
          </div>
          {plan.items.length ? (
            <div className="tablewrap">
              <table>
                <thead><tr><th>What</th><th>Item</th><th>Import</th></tr></thead>
                <tbody>
                  {plan.items.map((i) => (
                    <tr key={`${i.section}/${i.key}`}>
                      <td className="faint">{SECTIONS.find((s) => s.id === i.section)?.label ?? i.section}</td>
                      <td>{i.label}{i.reason && <div className="hint">{i.reason}</div>}</td>
                      <td><span className={`chip ${ACTION_CHIP[i.action]}`}>{ACTION_TEXT[i.action]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">The export has nothing in the chosen parts.</div>
          )}
          {plan.items.some((i) => i.section === "users" && i.action === "replace") && (
            <div className="notice warn" style={{ marginTop: 12 }}>
              Replaced users get the password they have in the export and are signed out, you too if your account is among them.
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <span className="grow hint">{plan.counts.add} to add, {plan.counts.replace} to replace, {plan.counts.skip} to skip</span>
            <button type="button" className="btn primary" disabled={busy || !changes} onClick={apply}>
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
