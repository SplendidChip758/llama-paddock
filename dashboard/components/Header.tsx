"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePaddock } from "./PaddockProvider";
import { JobsDrawer } from "./JobsDrawer";
import { statusOf } from "./ui";
import { Logo } from "./Logo";

export function Header() {
  const { instances, jobs, setJobsOpen } = usePaddock();
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
      </header>
      <JobsDrawer />
    </>
  );
}
