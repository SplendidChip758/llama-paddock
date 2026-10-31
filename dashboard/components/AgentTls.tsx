"use client";

import { useState } from "react";
import { api, instPath } from "@/lib/format";
import type { InstanceSnapshot } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";

export const agentEncrypted = (st: InstanceSnapshot) => !!st.agent_url?.startsWith("https:");

/** An http:// agent that reports a key, so it can be switched to https:// from here. */
const canSwitch = (st: InstanceSnapshot) => st.has_agent && !agentEncrypted(st) && !!st.agent_https_fingerprint;

/** "not encrypted" for agents still on http://, with what to do about it. */
export function AgentPlainChip({ st }: { st: InstanceSnapshot }) {
  if (!st.has_agent || agentEncrypted(st)) return null;
  const title = st.agent_https_fingerprint
    ? "The agent token crosses the network in plain text. The agent supports HTTPS: switch to it."
    : "The agent token crosses the network in plain text. Update the agent to 0.7.0 or later for HTTPS.";
  return <span className="chip warn" title={title}>not encrypted</span>;
}

function useSwitch() {
  const { refreshInstances, toast } = usePaddock();
  const [busy, setBusy] = useState(false);
  const run = async (hosts: InstanceSnapshot[]) => {
    setBusy(true);
    const failed: string[] = [];
    for (const h of hosts) {
      try {
        await api(instPath(h.id, "/agent-https"), { method: "POST" });
      } catch (e) {
        failed.push((e as Error).message);
      }
    }
    await refreshInstances();
    setBusy(false);
    const done = hosts.length - failed.length;
    if (done) toast(`Switched ${done === 1 && hosts.length === 1 ? hosts[0].name : `${done} agents`} to HTTPS`, "ok");
    for (const f of failed) toast(f, "bad");
  };
  return [busy, run] as const;
}

/** The agent presented a key other than the pinned one: explain, and let an admin accept it. */
export function AgentKeyNotice({ st }: { st: InstanceSnapshot }) {
  const { refreshInstances, toast } = usePaddock();
  const [busy, setBusy] = useState(false);
  const presented = st.agent_key_changed;
  if (!presented) return null;

  const accept = async () => {
    if (!confirm(`Pin the key ${presented} for ${st.name}'s agent? Only do this if it matches what the agent installer printed.`)) return;
    setBusy(true);
    try {
      await api(instPath(st.id, "/agent-key"), { method: "POST", body: { fingerprint: presented } });
      toast(`Accepted the new key for ${st.name}`, "ok");
      await refreshInstances();
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notice bad">
      <b>The agent&apos;s key has changed.</b> The dashboard stopped calling it, because a different key can also mean that
      something else answers at its address.
      <div className="mono" style={{ margin: "8px 0", fontSize: 12, wordBreak: "break-all" }}>
        <div>pinned:    {st.agent_fingerprint}</div>
        <div>presented: {presented}</div>
      </div>
      {st.agent_fingerprint_in_config ? (
        <>If you replaced the agent&apos;s key, set <code>agent_fingerprint: &quot;{presented}&quot;</code> for this host in config.yaml and restart the dashboard.</>
      ) : (
        <div className="row">
          <span className="grow">If you replaced the agent&apos;s key, compare the presented key with the installer&apos;s output.</span>
          <button className="btn" onClick={accept} disabled={busy}>{busy ? "Accepting…" : "Accept new key"}</button>
        </div>
      )}
    </div>
  );
}

/** One host's agent is on http:// but supports HTTPS. */
export function HttpsOffer({ st }: { st: InstanceSnapshot }) {
  const [busy, run] = useSwitch();
  if (!canSwitch(st)) return null;
  return (
    <div className="notice warn">
      <div className="row">
        <span className="grow">
          The connection to the agent isn&apos;t encrypted, so its token crosses the network in plain text. The agent supports
          HTTPS with the key <span className="mono">{st.agent_https_fingerprint}</span>.
        </span>
        {st.source === "ui" && (
          <button className="btn" onClick={() => run([st])} disabled={busy}>{busy ? "Switching…" : "Switch to HTTPS"}</button>
        )}
      </div>
      {st.source === "config" && (
        <div className="hint">
          In config.yaml, change this host&apos;s <code>agent_url</code> to <code>https://</code> and add{" "}
          <code>agent_fingerprint: &quot;{st.agent_https_fingerprint}&quot;</code>.
        </div>
      )}
    </div>
  );
}

/** The overview's offer to switch every agent that supports HTTPS at once. */
export function FleetHttpsOffer({ instances }: { instances: InstanceSnapshot[] }) {
  const [busy, run] = useSwitch();
  const hosts = instances.filter((s) => canSwitch(s) && s.source === "ui");
  if (!hosts.length) return null;
  return (
    <div className="notice warn row">
      <span className="grow">
        {hosts.length === 1 ? `${hosts[0].name}'s agent supports` : `${hosts.length} agents support`} HTTPS but{" "}
        {hosts.length === 1 ? "is" : "are"} connected over plain HTTP, so the agent token crosses the network unencrypted.
      </span>
      <button className="btn" onClick={() => run(hosts)} disabled={busy}>
        {busy ? "Switching…" : hosts.length === 1 ? "Switch to HTTPS" : "Switch all to HTTPS"}
      </button>
    </div>
  );
}
