"use client";

import { usePathname } from "next/navigation";
import { useDiagnosticsVisibility } from "@/lib/diagnostics-visibility";

const primaryNav = [["/", "Home"], ["/onboarding", "Profile"], ["/jobs", "Jobs"], ["/applications", "Applications"]] as const;

export function AppNav({ canManageMembers = false }: { canManageMembers?: boolean }) {
  const pathname = usePathname();
  const showDiagnostics = useDiagnosticsVisibility();
  const moreActive = ["/assessments", "/documents", "/profile", "/diagnostics", "/members"].some((path) => pathname.startsWith(path));
  return <nav className="nav" aria-label="Main navigation">
    {primaryNav.map(([href, label]) => {
      const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
      return <a className={active ? "active" : ""} href={href} key={href}><span>{label}</span></a>;
    })}
    <details className="navMore" open={moreActive}>
      <summary className={moreActive ? "active" : ""}>More</summary>
      <div className="navMoreLinks">
        <a className={pathname.startsWith("/assessments") ? "active" : ""} href="/assessments">Assessments</a>
        <a className={pathname.startsWith("/documents") ? "active" : ""} href="/documents">Documents</a>
        <a className={pathname.startsWith("/profile") ? "active" : ""} href="/profile">Profile details</a>
        {showDiagnostics ? <a className={pathname.startsWith("/diagnostics") ? "active" : ""} href="/diagnostics">Diagnostics</a> : null}
        {canManageMembers ? <a className={pathname.startsWith("/members") ? "active" : ""} href="/members">Members</a> : null}
      </div>
    </details>
  </nav>;
}
