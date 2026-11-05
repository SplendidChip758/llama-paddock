"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/format";
import type { ActiveAlert, InstanceSnapshot, JobInfo } from "@/lib/types";

interface Toast {
  id: number;
  msg: string;
  kind: "" | "ok" | "bad";
}

export interface Me {
  auth: boolean;
  username?: string | null;
  role?: "admin" | "viewer" | null;
}

interface Ctx {
  instances: InstanceSnapshot[];
  /** Re-fetch the fleet now, e.g. after adding or editing a host. */
  refreshInstances: () => Promise<void>;
  me: Me | null;
  /** A viewer account: hide the controls that change something (the server refuses them anyway). */
  readOnly: boolean;
  loaded: boolean;
  pollInterval: number;
  jobs: JobInfo[];
  refreshJobs: () => Promise<void>;
  toast: (msg: string, kind?: Toast["kind"]) => void;
  jobsOpen: boolean;
  setJobsOpen: (open: boolean) => void;
  /** Bumped when a pull/create job finishes, so model lists can reload. */
  jobsDoneTick: number;
  /** firing and pending alerts, refreshed with the fleet */
  alerts: ActiveAlert[];
  /** saving alert transitions failed: firing alerts may not survive a dashboard restart */
  alertsStoreError: string | null;
}

const PaddockCtx = createContext<Ctx | null>(null);

export function usePaddock() {
  const c = useContext(PaddockCtx);
  if (!c) throw new Error("usePaddock outside PaddockProvider");
  return c;
}

export function PaddockProvider({ children }: { children: ReactNode }) {
  const [instances, setInstances] = useState<InstanceSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pollInterval, setPollInterval] = useState(3);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobsDoneTick, setJobsDoneTick] = useState(0);
  const [me, setMe] = useState<Me | null>(null);
  const [alerts, setAlerts] = useState<ActiveAlert[]>([]);
  const [alertsStoreError, setAlertsStoreError] = useState<string | null>(null);
  const seenDone = useRef<Set<string> | null>(null);
  const toastId = useRef(0);
  const pollRef = useRef(3);
  pollRef.current = pollInterval;

  const toast = useCallback((msg: string, kind: Toast["kind"] = "") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "bad" ? 9000 : 4500);
  }, []);

  const refreshInstances = useCallback(async () => {
    const [d, a] = await Promise.all([
      api<{ poll_interval: number; instances: InstanceSnapshot[] }>("/api/instances"),
      api<{ active: ActiveAlert[]; store_error: string | null }>("/api/alerts").catch(() => null),
    ]);
    setPollInterval(d.poll_interval);
    setInstances(d.instances);
    if (a) {
      setAlerts(a.active);
      setAlertsStoreError(a.store_error);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(console.error);
  }, []);

  // fleet snapshot
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      try {
        await refreshInstances();
      } catch (e) {
        console.error(e);
      }
      if (!stopped) timer = setTimeout(tick, pollRef.current * 1000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refreshInstances]);

  const refreshJobs = useCallback(async () => {
    const d = await api<{ jobs: JobInfo[] }>("/api/jobs");
    setJobs(d.jobs);
    const first = seenDone.current === null;
    if (first) seenDone.current = new Set();
    let finished = false;
    for (const j of d.jobs) {
      if (j.state === "running" || seenDone.current!.has(j.id)) continue;
      seenDone.current!.add(j.id);
      if (first) continue;
      finished = true;
      if (j.state === "done") toast(`${j.kind === "pull" ? "Pulled" : "Created"} ${j.model} on ${j.instance}`, "ok");
      else if (j.state === "error") toast(`${j.kind} ${j.model} failed: ${j.error}`, "bad");
    }
    if (finished) setJobsDoneTick((n) => n + 1);
  }, [toast]);

  useEffect(() => {
    const t = setInterval(() => refreshJobs().catch(console.error), 1500);
    refreshJobs().catch(console.error);
    return () => clearInterval(t);
  }, [refreshJobs]);

  return (
    <PaddockCtx.Provider value={{ instances, refreshInstances, me, readOnly: me?.role === "viewer", loaded, pollInterval, jobs, refreshJobs, toast, jobsOpen, setJobsOpen, jobsDoneTick, alerts, alertsStoreError }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </PaddockCtx.Provider>
  );
}
