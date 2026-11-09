"use client";

import { useState } from "react";
import { api, instPath } from "@/lib/format";
import type { InstanceSnapshot } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";

const running = (st: InstanceSnapshot) => st.agent_update?.run?.state === "running";
const canUpdate = (st: InstanceSnapshot) => !!st.agent_update?.outdated && st.agent_update.can_update && !running(st);

/** "agent update", "updating agent" or "agent update failed", for the host cards and the host page. */
export function AgentUpdateChip({ st }: { st: InstanceSnapshot }) {
  const u = st.agent_update;
  if (!u) return null;
  if (u.run?.state === "running") return <span className="chip" title={`Updating the agent from ${u.run.from ?? "an unknown version"}`}>updating agent</span>;
  if (u.run?.state === "failed") return <span className="chip bad" title={u.run.detail ?? undefined}>agent update failed</span>;
  if (!u.outdated) return null;
  return <span className="chip warn" title={`Agent ${st.agent_version} is installed; ${u.latest} is out`}>agent update</span>;
}

/** The agent version, with the newer release when there is one. */
export function agentVersionText(st: InstanceSnapshot) {
  const v = st.agent_version ?? "unknown";
  return st.agent_update?.outdated ? `${v} (${st.agent_update.latest} available)` : v;
}

function useUpdate() {
  const { refreshInstances, toast } = usePaddock();
  const [busy, setBusy] = useState(false);
  const run = async (hosts: InstanceSnapshot[]) => {
    const names = hosts.length === 1 ? `${hosts[0].name}'s agent` : `${hosts.length} agents`;
    if (!confirm(`Update ${names} to the newest release? The agent restarts; Ollama keeps running.`)) return;
    setBusy(true);
    try {
      if (hosts.length === 1) {
        await api(instPath(hosts[0].id, "/agent-update"), { method: "POST" });
        toast(`Updating ${names}`, "ok");
      } else {
        const r = await api<{ started: string[]; skipped: { id: string; detail: string }[]; failed: { id: string; detail: string }[] }>(
          "/api/agent-updates", { method: "POST" },
        );
        if (r.started.length) toast(`Updating ${r.started.length} agent${r.started.length === 1 ? "" : "s"}`, "ok");
        for (const f of r.failed) toast(`${f.id}: ${f.detail}`, "bad");
      }
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      await refreshInstances();
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/** One host's agent: a newer release, an update in progress, or why the last one failed. */
export function AgentUpdateNotice({ st }: { st: InstanceSnapshot }) {
  const { readOnly } = usePaddock();
  const [busy, update] = useUpdate();
  const u = st.agent_update;
  if (!u) return null;
  const r = u.run;

  if (r?.state === "running") {
    return (
      <div className="notice row">
        <span className="grow">
          Updating the agent from {r.from ?? "an unknown version"}. It restarts when the new version is installed, which
          usually takes under a minute; Ollama keeps running.
        </span>
      </div>
    );
  }
  if (r?.state === "failed") {
    return (
      <div className="notice bad">
        <div className="row">
          <span className="grow"><b>The agent update failed:</b> {r.detail}</span>
          {u.can_update && !readOnly && <button className="btn" onClick={() => update([st])} disabled={busy}>{busy ? "Starting…" : "Try again"}</button>}
        </div>
        {r.log.length > 0 && (
          <details>
            <summary>Updater output</summary>
            <pre className="mono" style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{r.log.join("\n")}</pre>
          </details>
        )}
      </div>
    );
  }
  if (r?.state === "done") {
    return (
      <div className="notice ok row">
        <span className="grow">
          {r.detail ? `Agent update finished: ${r.detail}.` : `The agent was updated from ${r.from ?? "an unknown version"} to ${r.to}.`}
        </span>
      </div>
    );
  }
  if (!u.outdated) return null;
  return (
    <div className="notice warn">
      <div className="row">
        <span className="grow">
          Agent {u.latest} is out; this host runs {st.agent_version}.
          {!u.can_update && u.manual_reason && <> The dashboard can&apos;t update it: {u.manual_reason}.</>}
        </span>
        {u.can_update && !readOnly && (
          <button className="btn" onClick={() => update([st])} disabled={busy}>{busy ? "Starting…" : "Update agent"}</button>
        )}
      </div>
    </div>
  );
}

/** The overview's offer to update every outdated agent at once. */
export function FleetAgentUpdateOffer({ instances }: { instances: InstanceSnapshot[] }) {
  const { readOnly } = usePaddock();
  const [busy, update] = useUpdate();
  const outdated = instances.filter((s) => s.agent_update?.outdated && !running(s));
  if (!outdated.length) return null;
  const able = outdated.filter(canUpdate);
  const manual = outdated.length - able.length;
  const one = outdated.length === 1;
  return (
    <div className="notice warn row">
      <span className="grow">
        {one ? `${outdated[0].name}'s agent is` : `${outdated.length} agents are`} older than the latest release.
        {manual > 0 && ` ${manual === outdated.length ? (one ? "It needs" : "They need") : `${manual} of them need`} updating on the host: open ${one ? "the host" : "each host"} for how.`}
      </span>
      {!readOnly && able.length > 0 && (
        <button className="btn" onClick={() => update(able)} disabled={busy}>
          {busy ? "Starting…" : able.length === 1 ? "Update agent" : `Update ${able.length} agents`}
        </button>
      )}
    </div>
  );
}
