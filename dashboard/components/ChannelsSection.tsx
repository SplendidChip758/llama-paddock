"use client";

import { useState, type FormEvent } from "react";
import { CHANNEL_TYPES, SMTP_PORTS } from "@/lib/channels";
import { api, fmtDur } from "@/lib/format";
import type { ChannelType, NotifyChannel } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

type Security = "tls" | "starttls" | "none";

/** A channel as the API takes it: blank secrets keep the stored ones. */
interface ChannelInput {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
  send_resolved: boolean;
  url: string;
  token: string;
  clear_token?: boolean;
  email: { host: string; port: number; security: Security; username: string | null; password: string; from: string; to: string[] } | null;
}

function toInput(c: NotifyChannel): ChannelInput {
  const e = c.email;
  return {
    id: c.id, name: c.name, type: c.type, enabled: c.enabled, send_resolved: c.send_resolved, url: "", token: "",
    email: e && { host: e.host, port: e.port, security: e.security, username: e.username, password: "", from: e.from, to: e.to },
  };
}

/** "sent 3m ago", "failed 1m ago: …", or nothing yet. */
function statusLine(c: NotifyChannel): { cls: "" | "ok" | "bad"; text: string } {
  const s = c.status;
  const ago = (t: number) => `${fmtDur(Date.now() / 1000 - t)} ago`;
  const waiting = s.queued ? ` · ${s.queued} waiting` : "";
  if (s.last_error && s.last_error_at && (!s.last_ok || s.last_error_at > s.last_ok)) {
    return { cls: "bad", text: `failed ${ago(s.last_error_at)}: ${s.last_error}${waiting}` };
  }
  if (s.last_ok) return { cls: "ok", text: `last sent ${ago(s.last_ok)}${waiting}` };
  return { cls: "", text: `nothing sent since the dashboard started${waiting}` };
}

function target(c: NotifyChannel) {
  if (c.email) return `${c.email.to.join(", ")} via ${c.email.host}`;
  return c.url_hint ?? "";
}

export function ChannelsSection({ channels, onSaved }: { channels: NotifyChannel[] | null; onSaved: (c: NotifyChannel[]) => void }) {
  const { toast, readOnly } = usePaddock();
  // index into channels, or "new"
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);

  /** Store the whole list: the API replaces the channels. Returns false when it was refused. */
  const save = async (next: ChannelInput[], msg: string) => {
    setBusy(true);
    try {
      onSaved((await api<{ channels: NotifyChannel[] }>("/api/alerts/channels", { method: "PUT", body: { channels: next } })).channels);
      toast(msg, "ok");
      return true;
    } catch (e) {
      toast((e as Error).message, "bad");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <div className="card-head">
        <h2>Notifications</h2>
        {!readOnly && <button className="btn" onClick={() => setEditing("new")} disabled={!channels}>Add channel</button>}
      </div>
      <div className="card">
        {channels === null ? (
          <div className="empty">Loading channels…</div>
        ) : channels.length === 0 ? (
          <div className="empty">
            No channels. Add a webhook, Discord, Slack or email channel to be told when an alert fires and resolves.
          </div>
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>On</th><th>Channel</th><th>Sends to</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {channels.map((c, i) => {
                  const st = statusLine(c);
                  return (
                    <tr key={c.id} className={c.enabled ? "" : "off"}>
                      <td>
                        <input type="checkbox" checked={c.enabled} disabled={busy || readOnly} aria-label={`${c.enabled ? "Disable" : "Enable"} ${c.name}`}
                          onChange={() => save(channels.map((x, j) => ({ ...toInput(x), enabled: j === i ? !x.enabled : x.enabled })),
                            `${c.enabled ? "Disabled" : "Enabled"} ${c.name}`)} />
                      </td>
                      <td><b>{c.name}</b><div className="faint" style={{ fontSize: 12 }}>{CHANNEL_TYPES[c.type].label}{c.send_resolved ? "" : " · firing only"}</div></td>
                      <td className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{target(c)}</td>
                      <td className="chstatus">
                        {st.cls && <span className={`dot ${st.cls}`} />} <span className={st.cls === "bad" ? "" : "faint"}>{st.text}</span>
                      </td>
                      <td><div className="actions">{!readOnly && <button className="btn sm" onClick={() => setEditing(i)}>Edit</button>}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Each rule sends to every channel unless you choose some in the rule. Failed messages are retried for a few minutes;
        messages still waiting when the dashboard stops are lost.
      </div>

      {editing !== null && channels && (
        <ChannelEditor
          channel={editing === "new" ? undefined : channels[editing]}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (c) => {
            const others = channels.map(toInput);
            const next = editing === "new" ? [...others, c] : others.map((x, j) => (j === editing ? c : x));
            if (await save(next, `Saved ${c.name || CHANNEL_TYPES[c.type].label}`)) setEditing(null);
          }}
          onDelete={editing === "new" ? undefined : async () => {
            const c = channels[editing];
            if (!confirm(`Delete the channel ${c.name}? Rules that chose it stop sending there.`)) return;
            if (await save(channels.filter((_, j) => j !== editing).map(toInput), `Deleted ${c.name}`)) setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ChannelEditor({ channel, busy, onClose, onSave, onDelete }: {
  channel?: NotifyChannel;
  busy: boolean;
  onClose: () => void;
  onSave: (c: ChannelInput) => void;
  onDelete?: () => void;
}) {
  const [type, setType] = useState<ChannelType>(channel?.type ?? "discord");
  const [name, setName] = useState(channel?.name ?? "");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [security, setSecurity] = useState<Security>(channel?.email?.security ?? "starttls");
  const [host, setHost] = useState(channel?.email?.host ?? "");
  const [port, setPort] = useState(channel?.email ? String(channel.email.port) : "");
  const [username, setUsername] = useState(channel?.email?.username ?? "");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState(channel?.email?.from ?? "");
  const [to, setTo] = useState(channel?.email?.to.join(", ") ?? "");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [sendResolved, setSendResolved] = useState(channel?.send_resolved ?? true);
  const [check, setCheck] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const { toast } = usePaddock();
  const info = CHANNEL_TYPES[type];
  const isEmail = type === "email";

  const input = (): ChannelInput => ({
    id: channel?.id ?? "", name: name.trim() || info.label, type, enabled, send_resolved: sendResolved,
    url: isEmail ? "" : url.trim(), token: type === "webhook" ? token.trim() : "", clear_token: clearToken,
    email: isEmail
      ? { host: host.trim(), port: Number(port) || SMTP_PORTS[security], security, username: username.trim() || null, password, from: from.trim(), to: to.split(/[,;\s]+/).filter(Boolean) }
      : null,
  });

  const test = async () => {
    setTesting(true);
    setCheck(null);
    try {
      setCheck(await api<{ ok: boolean; detail: string }>("/api/alerts/channels/test", { method: "POST", body: { channel: input() } }));
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setTesting(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(input());
  };

  const keep = (has: boolean, what: string) => (has ? "unchanged (leave blank to keep)" : what);

  return (
    <Drawer open onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <div className="drawer-head">
          <h3>{channel ? `Edit ${channel.name}` : "Add channel"}</h3>
          <button type="button" className="ghost" onClick={onClose}>✕</button>
        </div>

        <label className="field">
          <span>Type</span>
          <select value={type} disabled={!!channel} onChange={(e) => { setType(e.target.value as ChannelType); setCheck(null); }}>
            {(Object.keys(CHANNEL_TYPES) as ChannelType[]).map((t) => <option key={t} value={t}>{CHANNEL_TYPES[t].label}</option>)}
          </select>
          <div className="hint">{info.help}</div>
        </label>

        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={info.label} />
        </label>

        {!isEmail && (
          <label className="field">
            <span>{type === "webhook" ? "URL" : "Webhook URL"}</span>
            <input type="password" autoComplete="new-password" value={url} onChange={(e) => setUrl(e.target.value)} required={!channel}
              placeholder={keep(!!channel?.url_hint, type === "discord" ? "https://discord.com/api/webhooks/…" : type === "slack" ? "https://hooks.slack.com/services/…" : "https://…")} />
            <div className="hint">
              {channel?.url_hint ? <>Now <span className="mono">{channel.url_hint}</span>. </> : null}
              The URL works like a password: it&apos;s stored on the dashboard and never shown again.
            </div>
          </label>
        )}

        {type === "webhook" && (
          <>
            <label className="field">
              <span>Token (optional)</span>
              <input type="password" autoComplete="new-password" value={token} disabled={clearToken} onChange={(e) => setToken(e.target.value)}
                placeholder={keep(!!channel?.has_token, "sent as Authorization: Bearer")} />
            </label>
            {channel?.has_token && (
              <label className="row hint" style={{ gap: 6, margin: "-6px 0 14px" }}>
                <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} /> Remove the stored token
              </label>
            )}
          </>
        )}

        {isEmail && (
          <>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <label className="field grow">
                <span>SMTP server</span>
                <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" required spellCheck={false} />
              </label>
              <label className="field" style={{ width: 96 }}>
                <span>Port</span>
                <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} placeholder={String(SMTP_PORTS[security])} />
              </label>
            </div>
            <label className="field">
              <span>Encryption</span>
              <select value={security} onChange={(e) => setSecurity(e.target.value as Security)}>
                <option value="starttls">STARTTLS (usually port 587)</option>
                <option value="tls">TLS (usually port 465)</option>
                <option value="none">None (port 25, a relay on your network, no login)</option>
              </select>
            </label>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <label className="field grow">
                <span>User name</span>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="blank: no login" spellCheck={false} />
              </label>
              <label className="field grow">
                <span>Password</span>
                <input type="password" autoComplete="new-password" value={password} disabled={!username.trim()} onChange={(e) => setPassword(e.target.value)}
                  placeholder={keep(!!channel?.email?.has_password, "app password")} />
              </label>
            </div>
            <label className="field">
              <span>From</span>
              <input type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="paddock@example.com" required />
            </label>
            <label className="field">
              <span>To</span>
              <input type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="ops@example.com, you@example.com" required spellCheck={false} />
              <div className="hint">Comma-separated, up to 20.</div>
            </label>
          </>
        )}

        <label className="row hint" style={{ gap: 6, marginBottom: 6 }}>
          <input type="checkbox" checked={sendResolved} onChange={(e) => setSendResolved(e.target.checked)} /> Also send when an alert resolves
        </label>
        <label className="row hint" style={{ gap: 6, marginBottom: 14 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>

        {channel && (
          <div className="hint" style={{ marginBottom: 12 }}>
            <span className={`dot ${statusLine(channel).cls}`} /> {statusLine(channel).text}
          </div>
        )}
        {check && (
          <div className="checks">
            <div><span className={`dot ${check.ok ? "ok" : "bad"}`} /> <b>Test</b> {check.ok ? `${check.detail}. Check that it arrived.` : check.detail}</div>
          </div>
        )}

        <div className="row" style={{ marginTop: 20 }}>
          {onDelete && <button type="button" className="danger" onClick={onDelete} disabled={busy}>Delete</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={test} disabled={busy || testing}>{testing ? "Sending…" : "Send test"}</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? "Saving…" : channel ? "Save" : "Add channel"}</button>
        </div>
      </form>
    </Drawer>
  );
}
