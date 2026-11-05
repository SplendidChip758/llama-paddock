"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePaddock } from "./PaddockProvider";
import { JobsDrawer } from "./JobsDrawer";
import { statusOf } from "./ui";
import { Logo } from "./Logo";
import { api } from "@/lib/format";
import { loudAlerts } from "./AlertBits";

export function Header({ version }: { version: string }) {
  const pre = version.includes("-");
  const { instances, jobs, setJobsOpen, me, alerts, readOnly } = usePaddock();
  const path = usePathname();
  const m = path.match(/^\/i\/([^/]+)(?:\/([^/]+))?/);
  const currentId = m ? decodeURIComponent(m[1]) : null;
  const tab = m?.[2] ?? "monitor";
  const running = jobs.filter((j) => j.state === "running").length;
  // silenced and acknowledged alerts still show on the Alerts page, but don't call for attention
  const firing = loudAlerts(alerts).length;

  return (
    <>
      <header className="top">
        <Link className="brand" href="/" aria-label="llama-paddock home">
          <Logo />
        </Link>
        <span className={`ver ${pre ? "pre" : ""}`} title={`llama-paddock dashboard ${version}${pre ? " (prerelease)" : ""}`}>v{version}</span>
        <nav className="instnav">
          <Link href="/" className={path === "/" ? "active" : ""}>Overview</Link>
          {instances.map((st) => {
            const [c] = statusOf(st);
            return (
              <Link key={st.id} href={`/i/${encodeURIComponent(st.id)}/${currentId ? tab : "monitor"}`} className={currentId === st.id ? "active" : ""}>
                <span className={`dot ${c}`} />
                {st.name}
              </Link>
            );
          })}
        </nav>
        <Link href="/benchmarks" className={`jobsbtn ${path === "/benchmarks" ? "active" : ""}`} title="Run and compare benchmarks">Benchmarks</Link>
        {!readOnly && <Link href="/prompt" className={`jobsbtn ${path === "/prompt" ? "active" : ""}`} title="Chat with a model and time the answer">Prompt</Link>}
        <Link href="/alerts" className={`jobsbtn ${path === "/alerts" ? "active" : ""}`}
          title={firing ? `${firing} alert${firing === 1 ? "" : "s"} firing` : "Alert rules"}>
          <span>Alerts</span>
          {firing > 0 && <span className="pill alert">{firing}</span>}
        </Link>
        <button className="jobsbtn" onClick={() => setJobsOpen(true)} title="Pull / create jobs">
          <span>Jobs</span>
          <span className={`pill ${running ? "live" : ""}`}>{running || jobs.length}</span>
        </button>
        {me?.auth && me.username && <UserMenu username={me.username} role={me.role} />}
      </header>
      <JobsDrawer />
    </>
  );
}

function UserMenu({ username, role }: { username: string; role?: string | null }) {
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };
  return (
    <details className="usermenu">
      <summary title={role === "viewer" ? "Account (read-only)" : "Account"}>
        {username}{role === "viewer" && <span className="faint"> · viewer</span>}
      </summary>
      <div className="menu">
        {role === "admin" && <Link href="/users">Users</Link>}
        {role === "admin" && <Link href="/audit">Audit log</Link>}
        <Link href="/tokens">API tokens</Link>
        <Link href="/change-password">Change password</Link>
        <button onClick={signOut}>Sign out</button>
      </div>
    </details>
  );
}
