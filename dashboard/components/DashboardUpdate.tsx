"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { version } from "@/package.json";
import { ago as agoIso, api } from "@/lib/format";
import type { DashboardRelease, DashboardUpdate, DashboardUpdateEntry, DashboardUpdateRun } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Modal } from "./ui";

const docsRef = version.includes("-") ? "dev" : `v${version}`;
const docUrl = (anchor: string) => `https://github.com/SplendidChip758/llama-paddock/blob/${docsRef}/docs/operations.md#${anchor}`;

/** unix seconds, as the update API has them */
const ago = (t: number) => agoIso(new Date(t * 1000).toISOString());
const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");

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

  // also while the first answer from GitHub is on its way, as after a channel switch
  const running = active(u) || (!!u?.check && !u.checked && !u.error);
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

type Ask =
  | { kind: "rollback"; entry: DashboardUpdateEntry }
  | { kind: "channel"; to: "stable" | "dev" };

export function UpdateView() {
  const { readOnly, toast } = usePaddock();
  const { u, setU, load, error, gone } = useDashboardUpdate();
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);

  const post = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      setU(await api<DashboardUpdate>("/api/dashboard-update", { method: "POST", body }));
      toast(done, "ok");
      return true;
    } catch (e) {
      toast((e as Error).message, "bad");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    await load(true);
    setBusy(false);
  };
  const update = () => {
    if (!u?.latest) return;
    if (!confirm(`Update the dashboard to ${u.latest}?\n\nIt takes a full backup, installs the release and restarts, which takes a minute or two. If the new version doesn't start, the updater puts ${u.current} and the backup back.`)) return;
    void post({ version: u.latest }, `Updating to ${u.latest}`);
  };

  const installer = u?.method === "installer" && u.can_update;
  const locked = readOnly || busy || active(u);

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Updates</h1>
          <div className="sub">
            Check for new versions, pick a release channel and roll back an update. Agents are updated from each host&apos;s page.{" "}
            <a href={docUrl("updating-the-dashboard")} target="_blank" rel="noreferrer">How updates work</a>
          </div>
        </div>
      </div>

      {gone && active(u) && <div className="notice">The dashboard is restarting. This page reconnects when it is back.</div>}
      {error && !active(u) && <div className="notice bad">{error}</div>}
      {!u ? (
        !error && <div className="empty">Checking…</div>
      ) : (
        <>
          <section className="card upd" aria-label="Version and status">
            {installer && (
              <div className="upd-bar">
                <div className="row">
                  <span className="lbl" id="upd-chan">Channel</span>
                  <div className="seg" role="group" aria-labelledby="upd-chan">
                    {(["stable", "dev"] as const).map((c) => (
                      <button key={c} className={u.channel === c ? "on" : ""} aria-pressed={u.channel === c} disabled={locked}
                        onClick={() => u.channel !== c && setAsk({ kind: "channel", to: c })}>
                        {c === "stable" ? "Stable" : "Prerelease"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="row" style={{ marginLeft: "auto" }}>
                  <span className={`lbl ${u.channel === "dev" ? "off" : ""}`} id="upd-auto">Automatic updates</span>
                  <button className="switch" role="switch" aria-checked={!!u.auto_update} aria-labelledby="upd-auto"
                    title={u.channel === "dev" ? "Stable releases only: prereleases are installed by hand" : "Install new stable releases by themselves"}
                    disabled={locked || u.channel === "dev"}
                    onClick={() => void post({ action: "auto", enabled: !u.auto_update }, `Automatic updates ${u.auto_update ? "off" : "on"}`)} />
                </div>
              </div>
            )}
            {installer && u.channel === "dev" && (
              <div className="upd-warnband">This install follows prereleases: they are for testing and may be unstable.</div>
            )}
            <div className="upd-tiles">
              <div className="upd-tile">
                <div className="upd-icon info" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>
                </div>
                <div className="grow">
                  <div className="upd-kicker">Version</div>
                  <div className="upd-big mono">{u.current}</div>
                  <div className="sub" style={{ fontSize: 13 }}>
                    {u.method === "installer" ? "Installed with the installer" : u.method === "docker" ? "Docker image" : "Installed by hand"}
                    {" · "}
                    <a href={`https://github.com/SplendidChip758/llama-paddock/releases/tag/v${u.current}`} target="_blank" rel="noreferrer">Release notes</a>
                  </div>
                </div>
              </div>
              <StatusTile u={u} readOnly={readOnly} busy={busy} onRetry={update}
                onRollback={(entry) => setAsk({ kind: "rollback", entry })} />
            </div>
            <div className="upd-foot">
              <span className="grow sub" style={{ fontSize: 13 }}><FootText u={u} /></span>
              {u.check && <button className="btn" onClick={check} disabled={busy || active(u)}>Check now</button>}
              {installer && u.available && !readOnly && !active(u) && (
                <button className="btn primary" onClick={update} disabled={busy}>Update to {u.latest}</button>
              )}
            </div>
          </section>

          {u.method === "docker" && u.available && <DockerSteps u={u} />}

          {u.available && (
            <section className="section">
              {u.releases.map((r, i) => <ReleaseNotes key={r.version} r={r} open={i === 0} />)}
              {u.releases.length >= 10 && (
                <div className="hint">Older releases: <a href={u.url} target="_blank" rel="noreferrer">all release notes</a></div>
              )}
            </section>
          )}

          {u.method === "installer" && <History u={u} readOnly={readOnly} busy={busy} onRollback={(entry) => setAsk({ kind: "rollback", entry })} />}
        </>
      )}

      {ask?.kind === "rollback" && (
        <RollbackModal entry={ask.entry} current={u?.current ?? version} busy={busy} onClose={() => setAsk(null)}
          onConfirm={async () => {
            if (await post({ action: "rollback", backup: ask.entry.backup }, `Rolling back to ${ask.entry.from}`)) setAsk(null);
          }} />
      )}
      {ask?.kind === "channel" && u && (
        <ChannelModal to={ask.to} u={u} busy={busy} onClose={() => setAsk(null)}
          onConfirm={async () => {
            if (await post({ action: "channel", channel: ask.to }, ask.to === "dev" ? "Switching to prereleases" : "Switching to stable releases")) setAsk(null);
          }} />
      )}
    </>
  );
}

const ACTION_NAMES: Record<DashboardUpdateRun["action"], string> = {
  update: "Update", rollback: "Roll back", channel: "Channel switch", automatic: "Automatic update",
};

function verb(r: Pick<DashboardUpdateRun, "action" | "version">) {
  if (r.action === "rollback") return `Rolling back to ${r.version}`;
  if (r.action === "channel") return "Switching channel";
  return `Updating to ${r.version ?? "the newest release"}`;
}

const PHASES: [NonNullable<DashboardUpdateRun["phase"]>, string][] = [
  ["verify", "Download and verify"], ["backup", "Full backup"], ["install", "Install and restart"], ["health", "Health check"],
];

function Tile({ tone, icon, kicker, title, children }: { tone: string; icon: ReactNode; kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="upd-tile">
      <div className={`upd-icon ${tone}`} aria-hidden="true">{icon}</div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="upd-kicker">{kicker}</div>
        <div className={`upd-big ${tone}`}>{title}</div>
        {children}
      </div>
    </div>
  );
}

const svg = (d: ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const ICON = {
  ok: svg(<><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></>),
  up: svg(<><path d="M12 19V5" /><path d="M5 12l7-7 7 7" /></>),
  spin: svg(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>),
  back: svg(<><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>),
  off: svg(<><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>),
};

function StatusTile({ u, readOnly, busy, onRetry, onRollback }: {
  u: DashboardUpdate; readOnly: boolean; busy: boolean; onRetry: () => void; onRollback: (e: DashboardUpdateEntry) => void;
}) {
  const r = u.run;
  const sub = (x: ReactNode) => <div className="sub" style={{ fontSize: 13 }}>{x}</div>;
  if (r?.state === "requested") {
    return (
      <Tile tone="info" icon={ICON.spin} kicker="Status" title={verb(r)}>
        {sub(r.message ?? "Waiting for the updater to start…")}
      </Tile>
    );
  }
  if (r?.state === "running") {
    const at = PHASES.findIndex(([p]) => p === r.phase);
    return (
      <Tile tone="info" icon={ICON.spin} kicker="Status" title={verb(r)}>
        {sub("The dashboard restarts on the way. This page reconnects by itself.")}
        {r.action !== "channel" && (
          <ol className="upd-steps" aria-label="Steps">
            {PHASES.map(([p, label], i) => (
              <li key={p} className={i < at ? "done" : i === at ? "now" : "todo"}>{i < at && "✓ "}{label}</li>
            ))}
          </ol>
        )}
      </Tile>
    );
  }
  // a finished run stays news for a day
  const fresh = r?.finished && Date.now() / 1000 - r.finished < 86400;
  if (r && fresh && r.state === "done") {
    const last = u.history.find((h) => h.backup && h.backup === r.backup);
    return (
      <Tile tone="ok" icon={ICON.ok} kicker="Status"
        title={r.action === "rollback" ? `Rolled back to ${r.version}` : r.action === "channel" && r.version === r.from ? "Channel switched" : `Updated to ${r.version}`}>
        {sub(<>
          {r.message ?? `From ${r.from}, ${ago(r.finished!)}.`}
          {last?.can_roll_back && !readOnly && <> Not right? <button className="linkbtn" disabled={busy} onClick={() => onRollback(last)}>Roll back to {last.from}</button></>}
        </>)}
      </Tile>
    );
  }
  if (r && fresh && (r.state === "failed" || r.state === "rolled_back")) {
    return (
      <Tile tone="bad" icon={ICON.back} kicker="Status"
        title={r.state === "rolled_back" ? `${ACTION_NAMES[r.action]} to ${r.version} failed. ${r.from} is back` : `${ACTION_NAMES[r.action]} failed`}>
        {sub(<>
          {r.message}
          {r.state === "rolled_back" && " The updater put the previous version and its backup back."}
        </>)}
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
          {r.action === "update" && u.available && !readOnly && <button className="btn sm" onClick={onRetry} disabled={busy}>Try again</button>}
          {r.log.length > 0 && (
            <details style={{ flexBasis: "100%" }}>
              <summary>Updater output</summary>
              <pre className="mono upd-log">{r.log.join("\n")}</pre>
            </details>
          )}
        </div>
      </Tile>
    );
  }
  if (!u.check) {
    return (
      <Tile tone="" icon={ICON.off} kicker="Status" title="Not checking for updates">
        {sub(<>update_check is off, so the dashboard doesn&apos;t ask GitHub. See the <a href={u.url} target="_blank" rel="noreferrer">releases</a>.</>)}
      </Tile>
    );
  }
  if (u.available) {
    const newest = u.releases[0];
    return (
      <Tile tone="warn" icon={ICON.up} kicker="Status" title={`Update available: ${u.latest}`}>
        {sub(<>{newest?.published && `Released ${ago(newest.published)} · `}{u.checked && `checked ${ago(u.checked)}`}</>)}
      </Tile>
    );
  }
  if (u.error) {
    return (
      <Tile tone="warn" icon={ICON.off} kicker="Status" title="Can't check for updates">
        {sub(u.error)}
      </Tile>
    );
  }
  return (
    <Tile tone="ok" icon={ICON.ok} kicker="Status" title={u.checked ? "Up to date" : "Checking…"}>
      {u.checked && sub(`${u.current} is the newest ${u.channel === "dev" ? "release" : "stable release"} · checked ${ago(u.checked)}`)}
    </Tile>
  );
}

function FootText({ u }: { u: DashboardUpdate }) {
  if (u.method === "docker") {
    return <>Channel: {u.channel === "dev" ? "prerelease (the :dev tag)" : "stable (the :latest tag)"}. Automatic updates and one-click rollback need the installer.</>;
  }
  if (u.method === "other") return <>This dashboard wasn&apos;t installed with the installer or the Docker image, so it can&apos;t update from here.</>;
  if (!u.can_update) return <>Run <code>update-llama-paddock</code> on the dashboard&apos;s machine once to update from here.</>;
  if (u.available) return <>Takes a full backup, installs, and rolls back by itself if {u.latest} doesn&apos;t start.</>;
  return <>Checks every 6 hours.{u.auto_update && " New stable releases install by themselves."}</>;
}

function DockerSteps({ u }: { u: DashboardUpdate }) {
  return (
    <section className="card section">
      <h2 style={{ margin: "0 0 6px" }}>Update to {u.latest}</h2>
      <p className="sub" style={{ margin: "0 0 10px", fontSize: 13 }}>
        Run these next to your <code>docker-compose.yml</code>. The backup command prints the backup&apos;s name: keep it for a rollback.
      </p>
      <pre className="mono upd-log">{"docker compose exec llama-paddock paddock-backup backup --reason pre-update\ndocker compose pull\ndocker compose up -d"}</pre>
      <p className="hint">If the new version doesn&apos;t work: <a href={docUrl("docker-updates")} target="_blank" rel="noreferrer">roll back a Docker update</a>.</p>
    </section>
  );
}

function History({ u, readOnly, busy, onRollback }: { u: DashboardUpdate; readOnly: boolean; busy: boolean; onRollback: (e: DashboardUpdateEntry) => void }) {
  return (
    <section className="card section">
      <h2 style={{ margin: "0 0 4px" }}>Update history</h2>
      <p className="sub" style={{ margin: "0 0 12px", fontSize: 13 }}>
        Updates from here, from the terminal and automatic ones. Roll back is offered while the update&apos;s pre-update backup is kept (the newest 5).
      </p>
      {u.history.length === 0 ? (
        <div className="empty">No updates yet.</div>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th>When</th><th>Action</th><th>Version</th><th>Result</th><th>By</th><th><span className="sr-only">Roll back</span></th></tr>
            </thead>
            <tbody>
              {u.history.map((h, i) => (
                <tr key={`${h.started}-${i}`}>
                  <td style={{ whiteSpace: "nowrap" }}>{when(h.finished ?? h.started)}</td>
                  <td>{ACTION_NAMES[h.action]}</td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{h.from ?? "?"} → {h.version ?? "?"}</td>
                  <td title={h.message ?? undefined}>
                    <span className={h.state === "done" ? "ok-text" : h.state === "rolled_back" ? "warn-text" : "bad-text"}>
                      {h.state === "done" ? "Succeeded" : h.state === "rolled_back" ? "Rolled back by itself" : "Failed"}
                    </span>
                  </td>
                  <td className={h.by === "automatic" || h.by === "terminal" ? "sub" : ""}>{h.by ?? "–"}</td>
                  <td className="r">
                    {h.can_roll_back && !readOnly && (
                      <button className="danger sm" disabled={busy || active(u)} onClick={() => onRollback(h)}>Roll back to {h.from}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RollbackModal({ entry, current, busy, onClose, onConfirm }: {
  entry: DashboardUpdateEntry; current: string; busy: boolean; onClose: () => void; onConfirm: () => void;
}) {
  return (
    <Modal onClose={onClose} labelledBy="upd-rb-title" className="upd-modal">
      <div className="modal-head"><h2 id="upd-rb-title">Roll back to {entry.from}?</h2></div>
      <div className="modal-body">
        <p>
          The dashboard goes back from {current} to {entry.from}, and to its data as it was before the update on {when(entry.started)},
          from the backup taken then.
        </p>
        <div className="notice warn">
          <b>Changes since then are lost:</b> metric history, alerts and benchmarks recorded since, and users, tokens or hosts
          added since. The current state is backed up first, so you can undo this.
        </div>
        <div className="hint mono">Backup {entry.backup}</div>
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger-fill" onClick={onConfirm} disabled={busy}>{busy ? "Starting…" : `Roll back to ${entry.from}`}</button>
      </div>
    </Modal>
  );
}

function ChannelModal({ to, u, busy, onClose, onConfirm }: {
  to: "stable" | "dev"; u: DashboardUpdate; busy: boolean; onClose: () => void; onConfirm: () => void;
}) {
  const dev = to === "dev";
  return (
    <Modal onClose={onClose} labelledBy="upd-ch-title" className="upd-modal">
      <div className="modal-head"><h2 id="upd-ch-title">{dev ? "Switch to prereleases?" : "Switch to stable releases?"}</h2></div>
      <div className="modal-body">
        {dev ? (
          <>
            <p>Prereleases are built from every change merged to dev, before it is released as stable. They are for testing and may be unstable.</p>
            <ul>
              <li>The newest prerelease is installed now, with a backup and automatic rollback.</li>
              <li>Automatic updates turn off: prereleases are always installed by hand.</li>
              <li>Going back to stable waits for the next stable release newer than the prerelease you&apos;re on.</li>
            </ul>
          </>
        ) : (
          <>
            <p>This install follows stable releases from now on.</p>
            <ul>
              <li>{u.current.includes("-") ? `${u.current} stays until a stable release newer than it is out: data can't go back to an older version.` : "The newest stable release is installed if it is newer."}</li>
              <li>Automatic updates can be turned on again.</li>
            </ul>
          </>
        )}
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={dev ? "btn warn-fill" : "btn primary"} onClick={onConfirm} disabled={busy}>
          {busy ? "Starting…" : dev ? "Switch to prereleases" : "Switch to stable"}
        </button>
      </div>
    </Modal>
  );
}

function ReleaseNotes({ r, open }: { r: DashboardRelease; open: boolean }) {
  return (
    <details className="card upd-notes" open={open}>
      <summary>
        <span className="upd-notes-title">{open ? `What's new in ${r.version}` : r.version}</span>
        <span className="hint" style={{ margin: 0 }}>
          {r.published && <>{ago(r.published)} · </>}
          <a href={r.url} target="_blank" rel="noreferrer">on GitHub</a>
        </span>
      </summary>
      <Markdown text={r.notes} />
    </details>
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
  return out.length ? <div style={{ fontSize: 13, marginTop: 8 }}>{out}</div> : <p className="hint">No release notes.</p>;
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
