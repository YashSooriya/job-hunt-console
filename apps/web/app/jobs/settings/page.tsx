import { AppShell } from "@/components/app-shell";
import { JobSearchPreferences } from "@/components/job-search-preferences";
import { SearchAutomationPanel } from "@/components/search-automation-panel";
import { JobsWorkspaceNav } from "@/components/jobs-workspace-nav";

export default function JobsSettingsPage() {
  return (
    <AppShell>
      <div className="pageHeader jobsPageHeader">
        <div>
          <div className="eyebrow">Your workspace</div>
          <h1 className="title">Search settings</h1>
          <p className="sub">Set your preferences and search schedule.</p>
        </div>
        <div className="pageHeaderActions"><a className="secondaryButton" href="/jobs">View job pool</a></div>
      </div>
      <JobsWorkspaceNav active="settings" />
      <JobSearchPreferences />
      <SearchAutomationPanel />
    </AppShell>
  );
}
