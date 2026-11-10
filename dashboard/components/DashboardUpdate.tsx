"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { version } from "@/package.json";
import { ago as agoIso, api } from "@/lib/format";
import type { DashboardRelease, DashboardUpdate } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";

const docsRef = version.includes("-") ? "dev" : `v${version}`;
const docUrl = (anchor: string) => `https://github.com/SplendidChip758/llama-paddock/blob/${docsRef}/docs/operations.md#${anchor}`;

/** unix seconds, as the update API has them */
const ago = (t: number) => agoIso(new Date(t * 1000).toISOString());

const active = (u: DashboardUpdate | null) => u?.run?.state === "requested" || u?.run?.state === "running";

/**
 * The dashboard's own update state. Asked for every 30 minutes (the server caches GitHub's answer for
 * hours), and every few seconds while an update runs, when the dashboard goes away and comes back.
 */
export function useDashboardUpdate() {
  const [u, setU] = useState<DashboardUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  const load = useCallback(async (refresh = false) => {
    try {
      const r = await api<DashboardUpdate>(`/api/dashboard-update${refresh ? "?refresh=1" : ""}`);
      setU(r);
      setError(null);
      setGone(false);
      // the new version serves new scripts: load them
      if (r.current !== version) window.location.reload();
      return r;
    } catch (e) {
      setError((e as Error).message);
      setGone(true);
      return null;
    }
  }, []);

  const running = active(u);
  useEffect(() => {
    void load();
    const t = setInterval(load, running ? 3000 : 30 * 60_000);
    return () => clearInterval(t);
  }, [load, running]);

  return { u, setU, load, error, gone };
}

/** The header's version, linking to the update page, with a pill when a newer release is out. */
export function VersionLink({ version: v }: { version: string }) {
  const { u } = useDashboardUpdate();
  const pre = v.includes("-");
  const title = `llama-paddock dashboard ${v}${pre ? " (prerelease)" : ""}${u?.available ? `: ${u.latest} is available` : ""}`;
  return (
    <Link className={`ver ${pre ? "pre" : ""}`} href="/update" title={title}
      aria-label={`Version ${v}${u?.available ? ", update available" : ""}`}>
      v{v}
      {u?.available && <span className="pill warn" style={{ marginLeft: 6 }}>update</span>}
    </Link>
  );
}

export function UpdateView() {
  const { readOnly, toast } = usePaddock();
  const { u, setU, load, error, gone } = useDashboardUpdate();
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    await load(true);
    setBusy(false);
  };
  const start = async () => {
    if (!u?.latest) return;
    if (!confirm(`Update the dashboard to ${u.latest}?\n\nIt takes a full backup, installs the release and restarts, which takes a minute or two. If the new version doesn't start, the updater puts ${u.current} and the backup back.`)) return;
    setBusy(true);
    try {
      setU(await api<DashboardUpdate>("/api/dashboard-update", { method: "POST", body: { version: u.latest } }));
      toast(`Updating to ${u.latest}`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Dashboard updates</h1>
          <div className="sub">
            This dashboard runs {u?.current ?? version}
            {u && <> on the {u.channel === "dev" ? "prerelease" : "stable"} channel</>}.{" "}
            <a href={docUrl("updating-the-dashboard")} target="_blank" rel="noreferrer">How updates work</a>
          </div>
        </div>
        {u?.check && (
          <div className="meta">
            {u.checked && <span>checked {ago(u.checked)}</span>}
            <button className="btn sm" onClick={check} disabled={busy || active(u)}>Check now</button>
          </div>
        )}
      </div>

      {gone && active(u) && <div className="notice">The dashboard is restarting. This page reconnects when it is back.</div>}
      {error && !active(u) && <div className="notice bad">{error}</div>}
      {!u ? (
        !error && <div className="empty">Checking…</div>
      ) : (
        <>
          <RunNotice u={u} />
          {!u.check && (
            <div className="notice">
              The update check is off (<code>update_check: false</code>), so the dashboard doesn&apos;t ask GitHub for new releases.
              See the <a href={u.url} target="_blank" rel="noreferrer">releases</a>.
            </div>
          )}
          {u.error && <div className="notice warn">{u.error}</div>}
          {u.check && !u.available && !u.error && u.checked && <div className="notice ok">This is the newest {u.channel === "dev" ? "prerelease" : "release"}.</div>}

          {u.available && (
            <div className="section">
              <div className="card">
                <div className="card-head">
                  <h2>Update available: {u.latest}</h2>
                  {u.method === "installer" && u.can_update && !readOnly && !active(u) && (
                    <button className="btn primary" onClick={start} disabled={busy}>{busy ? "Starting…" : `Update to ${u.latest}`}</button>
                  )}
                </div>
                <HowToUpdate u={u} readOnly={readOnly} />
              </div>
              {u.releases.map((r) => <ReleaseNotes key={r.version} r={r} />)}
              {u.releases.length >= 10 && (
                <div className="hint">Older releases: <a href={u.url} target="_blank" rel="noreferrer">all release notes</a></div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function RunNotice({ u }: { u: DashboardUpdate }) {
  const r = u.run;
  if (!r) return null;
  const log = r.log.length > 0 && (
    <details>
      <summary>Updater output</summary>
      <pre className="mono" style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{r.log.join("\n")}</pre>
    </details>
  );
  if (r.state === "requested") {
    return <div className={`notice ${r.message ? "warn" : ""}`}>{r.message ?? `Waiting for the updater to start the update to ${r.version}…`}</div>;
  }
  if (r.state === "running") {
    return <div className="notice">Updating from {r.from} to {r.version}: backing up, installing, then restarting the dashboard.{log}</div>;
  }
  // a finished run stays news for a day
  if (!r.finished || Date.now() / 1000 - r.finished > 86400) return null;
  if (r.state === "done") return <div className="notice ok">Updated from {r.from} to {r.version} {ago(r.finished)}.{r.backup && <> The backup taken before it is <code>{r.backup}</code>.</>}</div>;
  return (
    <div className="notice bad">
      <b>{r.state === "rolled_back" ? `The update to ${r.version} failed, and ${r.from} is back.` : `The update to ${r.version} failed.`}</b>{" "}
      {r.message}
      {r.backup && <> The backup taken before it is <code>{r.backup}</code> (<code>paddock-backup list</code>).</>}
      {log}
    </div>
  );
}

function HowToUpdate({ u, readOnly }: { u: DashboardUpdate; readOnly: boolean }) {
  if (u.method === "installer") {
    if (!u.can_update) {
      return (
        <p className="hint">
          Run <code>update-llama-paddock</code> on the dashboard&apos;s machine. That also sets up updates from here for next time.
        </p>
      );
    }
    if (readOnly) return <p className="hint">An admin can install it from this page.</p>;
    return (
      <p className="hint">
        The update takes a full backup, installs the release after checking it against the release&apos;s checksums, and restarts the
        dashboard. If the new version doesn&apos;t come up, the previous version and the backup are put back. Or run{" "}
        <code>update-llama-paddock</code> on the dashboard&apos;s machine.
      </p>
    );
  }
  if (u.method === "docker") {
    return (
      <>
        <p className="hint">This dashboard runs in Docker: update the image next to your <code>docker-compose.yml</code>. Take a backup first:</p>
        <pre className="mono" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
          {"docker compose exec llama-paddock paddock-backup backup --reason pre-update\ndocker compose pull\ndocker compose up -d"}
        </pre>
        <p className="hint">
          To go back, see <a href={docUrl("docker-updates")} target="_blank" rel="noreferrer">rolling back a Docker update</a>.
        </p>
      </>
    );
  }
  return (
    <p className="hint">
      This dashboard wasn&apos;t installed with the installer or the Docker image, so it can&apos;t update from here. Update it the way it
      was installed; <a href={docUrl("updates")} target="_blank" rel="noreferrer">update methods</a>.
    </p>
  );
}

function ReleaseNotes({ r }: { r: DashboardRelease }) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-head">
        <h3 style={{ margin: 0 }}>{r.version}</h3>
        <span className="hint">
          {r.published && <>{ago(r.published)} · </>}
          <a href={r.url} target="_blank" rel="noreferrer">on GitHub</a>
        </span>
      </div>
      <Markdown text={r.notes} />
    </div>
  );
}

/** The little Markdown release notes use: headings, bullets, links, bold and code. Rendered as text, never HTML. */
function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let items: ReactNode[] = [];
  const flush = () => {
    if (items.length) out.push(<ul key={out.length} style={{ margin: "4px 0 10px", paddingLeft: 20 }}>{items}</ul>);
    items = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const li = /^\s*[*-]\s+(.*)$/.exec(line);
    if (li) {
      items.push(<li key={items.length}>{inline(li[1])}</li>);
      continue;
    }
    flush();
    // the version heading repeats the card's title
    if (h && !/^\[?v?\d+\.\d+\.\d+/.test(h[1])) out.push(<h4 key={out.length} style={{ margin: "10px 0 4px" }}>{inline(h[1])}</h4>);
    else if (!h && line.trim()) out.push(<p key={out.length} style={{ margin: "4px 0" }}>{inline(line)}</p>);
  }
  flush();
  return out.length ? <div style={{ fontSize: 13 }}>{out}</div> : <p className="hint">No release notes.</p>;
}

function inline(s: string): ReactNode {
  const parts: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m; (m = re.exec(s)); ) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const k = parts.length;
    if (m[1] !== undefined) {
      parts.push(/^https?:\/\//.test(m[2]) ? <a key={k} href={m[2]} target="_blank" rel="noreferrer">{m[1]}</a> : m[1]);
    } else if (m[3] !== undefined) parts.push(<strong key={k}>{m[3]}</strong>);
    else parts.push(<code key={k}>{m[4]}</code>);
    last = re.lastIndex;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}
