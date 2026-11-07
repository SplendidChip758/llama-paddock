"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePaddock } from "./PaddockProvider";
import { JobsDrawer } from "./JobsDrawer";
import { statusOf } from "./ui";
import { Logo } from "./Logo";
import { api } from "@/lib/format";
import { DARK_ONLY, MODES, PALETTES, applyTheme, currentTheme, type Mode, type Palette } from "@/lib/theme";
import { loudAlerts } from "./AlertBits";

export function Header({ version }: { version: string }) {
  const pre = version.includes("-");
  const { instances, jobs, setJobsOpen, me, alerts, readOnly, security } = usePaddock();
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
        <Link href="/security" className={`jobsbtn ${path === "/security" ? "active" : ""}`}
          title={security?.failing ? `${security.failing} security check${security.failing === 1 ? "" : "s"} failing` : "Security checks"}>
          <span>Security</span>
          {!!security?.failing && <span className="pill warn">{security.failing}</span>}
        </Link>
        <button className="jobsbtn" onClick={() => setJobsOpen(true)} title="Pull / create jobs">
          <span>Jobs</span>
          <span className={`pill ${running ? "live" : ""}`}>{running || jobs.length}</span>
        </button>
        <ThemeMenu />
        {me?.auth && me.username && <UserMenu username={me.username} role={me.role} />}
      </header>
      <JobsDrawer />
    </>
  );
}

/** A header dropdown: <details> with the dismissal a menu needs. The children get a close function. */
function HeaderMenu({ className, summary, title, children }: {
  className: string;
  summary: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = () => {
    if (ref.current) ref.current.open = false;
  };
  // <details> only closes when its summary is clicked: also close it on a click elsewhere, on Escape,
  // and after following one of its links, since the header stays mounted across pages
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      ref.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  useEffect(close, [pathname]);
  return (
    <details className={`usermenu ${className}`} ref={ref} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary title={title}>{summary}</summary>
      {children(close)}
    </details>
  );
}

function UserMenu({ username, role }: { username: string; role?: string | null }) {
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };
  return (
    <HeaderMenu
      className="accountmenu"
      title={role === "viewer" ? "Account (read-only)" : "Account"}
      summary={<>{username}{role === "viewer" && <span className="faint"> · viewer</span>}</>}
    >
      {(close) => (
        <div className="menu" onClick={(e) => (e.target as HTMLElement).closest("a") && close()}>
          {role === "admin" && <Link href="/users">Users</Link>}
          {role === "admin" && <Link href="/audit">Audit log</Link>}
          <Link href="/tokens">API tokens</Link>
          <Link href="/change-password">Change password</Link>
          <button onClick={signOut}>Sign out</button>
        </div>
      )}
    </HeaderMenu>
  );
}

const MODE_NAMES: Record<Mode, string> = { system: "System", light: "Light", dark: "Dark" };

/** Light/dark mode and palette. It stays open while choosing, so both can be changed in one go. */
function ThemeMenu() {
  const [theme, setTheme] = useState<{ palette: Palette; mode: Mode } | null>(null);
  // read after mount: the inline script in app/layout.tsx has already applied the saved choice
  useEffect(() => setTheme(currentTheme()), []);
  const pick = (next: { palette: Palette; mode: Mode }) => {
    applyTheme(next.palette, next.mode);
    setTheme(next);
  };
  const darkOnly = !!theme && DARK_ONLY.includes(theme.palette);
  return (
    <HeaderMenu className="thememenu" title="Theme" summary={<span aria-label="Theme">◐</span>}>
      {() => (
        <div className="menu">
          <div className="menu-label" id="theme-mode">Mode</div>
          <div role="group" aria-labelledby="theme-mode">
            {MODES.map((m) => (
              <button key={m} aria-pressed={!darkOnly && theme?.mode === m} disabled={darkOnly} onClick={() => theme && pick({ ...theme, mode: m })}>
                {MODE_NAMES[m]}
              </button>
            ))}
          </div>
          {darkOnly && <div className="menu-hint">This theme is always dark.</div>}
          <div className="menu-label" id="theme-palette">Theme</div>
          <div role="group" aria-labelledby="theme-palette">
            {PALETTES.map((p) => (
              <button key={p.id} aria-pressed={theme?.palette === p.id} onClick={() => theme && pick({ ...theme, palette: p.id })}>
                <span className="swatch" aria-hidden="true">
                  {p.swatch.map((c) => <i key={c} style={{ background: c }} />)}
                </span>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </HeaderMenu>
  );
}
