import type { ReactNode } from "react";
import { getViewer } from "@/lib/viewer";
import { AppNav } from "@/components/app-nav";

export async function AppShell({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  const modeLabel = viewer.configured ? (viewer.authenticated ? "Supabase live" : "Supabase") : "Local snapshot";

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          JobHuntAI
          <small>Application Console</small>
        </div>
        <AppNav canManageMembers={viewer.canManageMembers} />
        <div className="sideFooter">
          <span className="modeDot" />
          <span>{modeLabel}</span>
          {viewer.email ? <small>{viewer.email}</small> : null}
          {viewer.configured && viewer.authenticated ? (
            <form action="/auth/signout" method="post">
              <button className="sideButton" type="submit">Sign out</button>
            </form>
          ) : null}
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

export function DataSourceBadge({ source }: { source: "local_snapshot" | "supabase" }) {
  return (
    <span className={`sourceBadge ${source === "supabase" ? "live" : ""}`}>
      {source === "supabase" ? "Live database" : "Validated local snapshot"}
    </span>
  );
}
