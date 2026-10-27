"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, instPath } from "@/lib/format";
import type { InstanceSnapshot } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

interface Check {
  ok: boolean;
  detail: string;
}

/** Only the scheme typed so far: "h", "http", "https:/", "http://". */
const partialScheme = (s: string) => "http://".startsWith(s.toLowerCase()) || "https://".startsWith(s.toLowerCase());

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/** Host name or IPv4 of a (possibly half-typed) URL; "" until there is one, or if the text isn't an http(s) URL. */
const hostOf = (url: string) => {
  const s = url.trim();
  if (partialScheme(s)) return "";
  const rest = s.replace(/^https?:\/\//i, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) return ""; // some other scheme, e.g. ftp://
  const host = rest.split(/[:/?#]/)[0];
  return HOST_RE.test(host) ? host : "";
};

/** Agent default: same host as Ollama, port 11435. */
const suggestAgent = (ollamaUrl: string) => (hostOf(ollamaUrl) ? `http://${hostOf(ollamaUrl)}:11435` : "");

/** Add a host (no `host`) or edit/remove one added in the UI. */
export function HostEditor({ host, onClose }: { host?: InstanceSnapshot; onClose: () => void }) {
  const { refreshInstances, toast } = usePaddock();
  const router = useRouter();
  const [name, setName] = useState(host?.name ?? "");
  const [ollamaUrl, setOllamaUrl] = useState(host?.ollama_url ?? "");
  const [agentUrl, setAgentUrl] = useState(host?.agent_url ?? "");
  const [agentTouched, setAgentTouched] = useState(!!host);
  const [token, setToken] = useState("");
  const [tags, setTags] = useState(host?.tags.join(", ") ?? "");
  const [checks, setChecks] = useState<{ ollama: Check; agent: Check | null } | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "save" | "delete">("");

  const body = () => ({ id: host?.id, name, ollama_url: ollamaUrl, agent_url: agentUrl, agent_token: token, tags });

  const onOllama = (v: string) => {
    setOllamaUrl(v);
    if (!agentTouched) setAgentUrl(suggestAgent(v));
  };

  const test = async () => {
    setBusy("test");
    setChecks(null);
    try {
      setChecks(await api("/api/test-connection", { method: "POST", body: body() }));
    } catch (e) {
      toast((e as Error).message, "bad");
    } finally {
      setBusy("");
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("save");
    try {
      if (host) {
        await api(instPath(host.id), { method: "PUT", body: body() });
        toast(`Saved ${name || host.name}`, "ok");
        await refreshInstances();
        onClose();
      } else {
        const r = await api<{ id: string }>("/api/instances", { method: "POST", body: body() });
        toast(`Added ${name || hostOf(ollamaUrl)}`, "ok");
        await refreshInstances();
        onClose();
        router.push(`/i/${encodeURIComponent(r.id)}/monitor`);
      }
    } catch (err) {
      toast((err as Error).message, "bad");
      setBusy("");
    }
  };

  const remove = async () => {
    if (!host || !confirm(`Remove ${host.name} from the dashboard? Nothing on the host itself is changed.`)) return;
    setBusy("delete");
    try {
      await api(instPath(host.id), { method: "DELETE" });
      toast(`Removed ${host.name}`, "ok");
      await refreshInstances();
      onClose();
      router.push("/");
    } catch (e) {
      toast((e as Error).message, "bad");
      setBusy("");
    }
  };

  return (
    <Drawer open onClose={onClose}>
      <form onSubmit={save} autoComplete="off">
        <div className="drawer-head">
          <h3>{host ? `Edit ${host.name}` : "Add host"}</h3>
          <button type="button" className="ghost" onClick={onClose}>✕</button>
        </div>

        <label className="field">
          <span>Ollama URL</span>
          <input type="text" value={ollamaUrl} onChange={(e) => onOllama(e.target.value)} placeholder="http://192.168.30.101:11434"
            required autoFocus={!host} />
          {ollamaUrl.trim() && !partialScheme(ollamaUrl.trim()) && !hostOf(ollamaUrl) ? (
            <div className="hint" style={{ color: "var(--bad)" }}>
              That doesn't look like a URL. Enter the Ollama address, e.g. <code>http://192.168.30.101:11434</code>.
            </div>
          ) : (
            <div className="hint">Ollama must listen on the network: <code>OLLAMA_HOST=0.0.0.0</code>.</div>
          )}
        </label>

        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={hostOf(ollamaUrl) || "ollama-01"} />
        </label>

        <h2 style={{ margin: "20px 0 10px" }}>Agent</h2>
        <div className="hint" style={{ marginBottom: 12 }}>
          Optional. The agent adds GPU and host stats, environment editing, restart and logs. Its installer prints the token.
        </div>
        <label className="field">
          <span>Agent URL</span>
          <input type="text" value={agentUrl} placeholder="blank if the host has no agent"
            onChange={(e) => { setAgentUrl(e.target.value); setAgentTouched(true); }} />
        </label>
        {agentUrl.trim() && (
          <label className="field">
            <span>Agent token</span>
            <input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={host?.has_token ? "unchanged (leave blank to keep)" : "printed by the agent installer"} />
          </label>
        )}

        <label className="field">
          <span>Tags</span>
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="p100, node-01" />
          <div className="hint">Comma-separated, optional.</div>
        </label>

        {checks && (
          <div className="checks">
            <div><span className={`dot ${checks.ollama.ok ? "ok" : "bad"}`} /> <b>Ollama</b> {checks.ollama.detail}</div>
            {checks.agent && <div><span className={`dot ${checks.agent.ok ? "ok" : "bad"}`} /> <b>Agent</b> {checks.agent.detail}</div>}
          </div>
        )}

        <div className="row" style={{ marginTop: 20 }}>
          {host && (
            <button type="button" className="danger" onClick={remove} disabled={!!busy}>
              {busy === "delete" ? "Removing…" : "Remove"}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={test} disabled={!!busy || !ollamaUrl.trim()}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button type="submit" className="btn primary" disabled={!!busy}>
            {busy === "save" ? "Saving…" : host ? "Save" : "Add host"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
