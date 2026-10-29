"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePaddock } from "./PaddockProvider";
import { JobsDrawer } from "./JobsDrawer";
import { statusOf } from "./ui";
import { Logo } from "./Logo";
import { api } from "@/lib/format";

export function Header({ version }: { version: string }) {
  const pre = version.includes("-");
  const { instances, jobs, setJobsOpen, me } = usePaddock();
  const path = usePathname();
  const m = path.match(/^\/i\/([^/]+)(?:\/([^/]+))?/);
  const currentId = m ? decodeURIComponent(m[1]) : null;
  const tab = m?.[2] ?? "monitor";
  const running = jobs.filter((j) => j.state === "running").length;

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
        <button className="jobsbtn" onClick={() => setJobsOpen(true)} title="Pull / create jobs">
          <span>Jobs</span>
          <span className={`pill ${running ? "live" : ""}`}>{running || jobs.length}</span>
        </button>
        {me?.auth && me.username && <UserMenu username={me.username} />}
      </header>
      <JobsDrawer />
    </>
  );
}

function UserMenu({ username }: { username: string }) {
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };
  return (
    <details className="usermenu">
      <summary title="Account">{username}</summary>
      <div className="menu">
        <Link href="/change-password">Change password</Link>
        <button onClick={signOut}>Sign out</button>
      </div>
    </details>
  );
}
