"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { version } from "@/package.json";
import { ago, api, instPath } from "@/lib/format";
import type { SecurityCheck, SecuritySummary, SecurityTarget } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";

// Prerelease guides live on dev; stable installs use their release's documentation.
const docsRef = version.includes("-") ? "dev" : `v${version}`;
const docUrl = (doc: string) => `https://github.com/SplendidChip758/llama-paddock/blob/${docsRef}/docs/${doc}`;

const STATE: Record<SecurityCheck["state"], { dot: string; chip: string; text: string }> = {
  fail: { dot: "bad", chip: "bad", text: "fail" },
  pass: { dot: "ok", chip: "ok", text: "pass" },
  unknown: { dot: "", chip: "", text: "unknown" },
  dismissed: { dot: "", chip: "", text: "dismissed" },
};

type Report = { targets: SecurityTarget[] } & SecuritySummary;

export function SecurityView() {
  const { pollInterval, refreshInstances, toast, readOnly } = usePaddock();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api<Report>("/api/security"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, Math.max(pollInterval, 3) * 1000);
    return () => clearInterval(t);
  }, [load, pollInterval]);

  const act = async (key: string, what: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await what();
      toast(done, "ok");
      await Promise.all([load(), refreshInstances()]);
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(null);
    }
  };

  const fix = (t: SecurityTarget, c: SecurityCheck) => {
    const action = c.fix?.action;
    if (action === "switch_https") {
      return act(`${t.instance}/${c.id}`, () => api(instPath(t.instance, "/agent-https"), { method: "POST" }), `Switched ${t.name}'s agent to HTTPS`);
    }
    if (action === "chmod_data") {
      return act(`${t.instance}/${c.id}`, () => api("/api/security/fix", { method: "POST", body: { check: "data_files" } }), "Made the data files private");
    }
  };

  const dismiss = (t: SecurityTarget, c: SecurityCheck) => {
    void act(`${t.instance}/${c.id}`, () => api("/api/security/dismissals", { method: "POST", body: { instance: t.instance, check: c.id } }), `Dismissed ${c.label} on ${t.name}`);
  };

  const restore = (t: SecurityTarget, c: SecurityCheck) =>
    act(`${t.instance}/${c.id}`, () => api(`/api/security/dismissals/${encodeURIComponent(t.instance)}/${c.id}`, { method: "DELETE" }), `${c.label} on ${t.name} counts again`);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Security</h1>
          <div className="sub">
            Settings that leave Ollama, the agents or the dashboard exposed. Failing checks fire the{" "}
            <Link href="/alerts">Security check failing</Link> alert rule.{" "}
            <a href={docUrl("security-checks.md")} target="_blank" rel="noreferrer">What each check means</a>
          </div>
        </div>
      </div>
      {error && <div className="notice bad">{error}</div>}
      {!report ? (
        <div className="empty">{error ? "Couldn't load the checks." : "Checking…"}</div>
      ) : (
        <>
          <div className={`notice ${report.failing ? "warn" : "ok"}`}>
            {report.failing ? `${report.failing} check${report.failing === 1 ? "" : "s"} failing.` : "Every check passes or can't tell yet."}
            {report.dismissed > 0 && ` ${report.dismissed} dismissed.`}
          </div>
          {report.targets.map((t) => (
            <div key={t.instance} className="section">
              <div className="card-head">
                <h2>{t.instance.startsWith("@") ? t.name : <Link href={`/i/${encodeURIComponent(t.instance)}/monitor`}>{t.name}</Link>}</h2>
              </div>
              <div className="card">
                {t.checks.map((c) => (
                  <CheckLine key={c.id} c={c} busy={busy === `${t.instance}/${c.id}`} readOnly={readOnly}
                    onFix={() => fix(t, c)} onDismiss={() => dismiss(t, c)} onRestore={() => restore(t, c)} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function CheckLine({ c, busy, readOnly, onFix, onDismiss, onRestore }: {
  c: SecurityCheck; busy: boolean; readOnly: boolean; onFix: () => void; onDismiss: () => void; onRestore: () => void;
}) {
  const s = STATE[c.state];
  const failing = c.state === "fail";
  return (
    <div className={`alertline ${c.state === "dismissed" ? "muted" : ""}`}>
      <span className={`dot ${s.dot}`} />
      <div className="grow">
        <div><b>{c.label}</b></div>
        <div className="hint" style={{ marginTop: 2 }}>{c.detail}</div>
        {c.dismissal && (
          <div className="hint" style={{ marginTop: 2 }}>
            Dismissed {ago(new Date(c.dismissal.t * 1000).toISOString())}{c.dismissal.user ? ` by ${c.dismissal.user}` : ""}
          </div>
        )}
      </div>
      <div className="chips" style={{ justifyContent: "flex-end", alignItems: "center" }}>
        {failing && c.fix && <FixLink c={c} busy={busy} readOnly={readOnly} onFix={onFix} />}
        {!readOnly && failing && <button className="btn sm" onClick={onDismiss} disabled={busy}>Dismiss</button>}
        {!readOnly && c.dismissal && <button className="btn sm" onClick={onRestore} disabled={busy}>Restore</button>}
        <span className={`chip ${s.chip}`}>{s.text}</span>
      </div>
    </div>
  );
}

function FixLink({ c, busy, readOnly, onFix }: { c: SecurityCheck; busy: boolean; readOnly: boolean; onFix: () => void }) {
  const f = c.fix!;
  if (f.action) return readOnly ? null : <button className="btn sm primary" onClick={onFix} disabled={busy}>{f.label}</button>;
  if (f.href) return <Link className="btn sm" href={f.href}>{f.label}</Link>;
  if (f.doc) return <a className="btn sm" href={docUrl(f.doc)} target="_blank" rel="noreferrer">{f.label}</a>;
  return null;
}
