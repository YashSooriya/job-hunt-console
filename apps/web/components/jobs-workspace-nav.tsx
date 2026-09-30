import type { ReactNode } from "react";

export function JobsWorkspaceNav({ active, children }: { active: "pool" | "add" | "settings"; children?: ReactNode }) {
  return (
    <div className="jobsWorkspaceBar">
      <nav className="jobsWorkspaceNav" aria-label="Jobs workspace">
        <a className={active === "pool" ? "active" : ""} href="/jobs">Job pool</a>
        <a className={active === "add" ? "active" : ""} href="/jobs/add">Add a job</a>
        <a className={active === "settings" ? "active" : ""} href="/jobs/settings">Search settings</a>
      </nav>
      {children ? <div className="jobsWorkspaceActions">{children}</div> : null}
    </div>
  );
}
