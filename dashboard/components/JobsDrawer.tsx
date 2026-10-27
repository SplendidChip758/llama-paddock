"use client";

import { api, fmtBytes, pct } from "@/lib/format";
import type { JobInfo } from "@/lib/types";
import { usePaddock } from "./PaddockProvider";
import { Drawer } from "./ui";

export function JobLine({ j }: { j: JobInfo }) {
  const { refreshJobs, toast } = usePaddock();
  const p = j.total ? pct(j.completed, j.total) : j.state === "done" ? 100 : 0;
  const cancel = () => api(`/api/jobs/${j.id}`, { method: "DELETE" }).then(refreshJobs).catch((e) => toast(e.message, "bad"));
  return (
    <div className="job">
      <div className="top-line">
        <div>
          <b className="mono">{j.model}</b> <span className="faint">· {j.kind} on {j.instance}</span>
        </div>
        <button className="ghost sm" onClick={cancel} title={j.state === "running" ? "cancel" : "dismiss"}>
          {j.state === "running" ? "Cancel" : "✕"}
        </button>
      </div>
      <div className="status">
        {j.error || j.status}
        {j.total ? ` · ${fmtBytes(j.completed)} / ${fmtBytes(j.total)}` : ""}
      </div>
      {j.detail && <div className="hint" style={{ marginBottom: 6 }}>{j.detail}</div>}
      <div className="bar">
        <i className={j.state === "error" ? "bad" : ""} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

export function JobsDrawer() {
  const { jobs, jobsOpen, setJobsOpen } = usePaddock();
  return (
    <Drawer open={jobsOpen} onClose={() => setJobsOpen(false)} className="jobsdrawer">
      <div className="drawer-head">
        <h3>Jobs</h3>
        <button className="ghost" onClick={() => setJobsOpen(false)}>✕</button>
      </div>
      {jobs.length ? jobs.map((j) => <JobLine key={j.id} j={j} />) : <div className="empty">No jobs yet</div>}
    </Drawer>
  );
}
