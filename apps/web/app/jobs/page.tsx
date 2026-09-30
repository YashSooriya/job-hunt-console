import { AppShell } from "@/components/app-shell";
import { JobsWorkspaceNav } from "@/components/jobs-workspace-nav";
import { JobPoolTable } from "@/components/job-pool-table";
import { ManualSearchButton } from "@/components/manual-search-button";
import { getJobDataset, getPreparationApplications } from "@/lib/data/repository";

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ sort?: string; direction?: string }> }) {
  const [jobs, preparation] = await Promise.all([getJobDataset(), getPreparationApplications()]);
  const params = await searchParams;

  return (
    <AppShell>
      <div className="pageHeader jobsPageHeader">
        <div>
          <div className="eyebrow">Your workspace</div>
          <h1 className="title">Jobs</h1>
          <p className="sub">Review saved listings or find new roles.</p>
        </div>
        <div className="pageHeaderActions"><ManualSearchButton /><a className="secondaryButton" href="/jobs/add">Add a job</a></div>
      </div>

      <JobsWorkspaceNav active="pool" />

      <JobPoolTable jobs={jobs.records} applications={preparation.records} analysisAvailable={jobs.source === "supabase"} initialSort={params.sort} initialDirection={params.direction} />
    </AppShell>
  );
}
