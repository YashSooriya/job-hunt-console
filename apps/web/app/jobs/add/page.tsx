import { AppShell } from "@/components/app-shell";
import { JobIngestForm } from "@/components/job-ingest-form";
import { JobUrlInspectionForm } from "@/components/job-url-inspection-form";
import { JobsWorkspaceNav } from "@/components/jobs-workspace-nav";

export default async function AddJobPage({ searchParams }: { searchParams: Promise<{ method?: string; sourceUrl?: string }> }) {
  const params = await searchParams;
  const method = params.method === "manual" ? "manual" : "url";
  return (
    <AppShell>
      <div className="pageHeader jobsPageHeader">
        <div>
          <div className="eyebrow">Your workspace</div>
          <h1 className="title">Add a job</h1>
          <p className="sub">Import a listing or enter a job yourself.</p>
        </div>
        <div className="pageHeaderActions"><a className="secondaryButton" href="/jobs">View job pool</a></div>
      </div>
      <JobsWorkspaceNav active="add" />
      <div className="jobEntryChooser" role="tablist" aria-label="Choose how to add a job">
        <a className={method === "url" ? "active" : ""} href="/jobs/add?method=url" role="tab" aria-selected={method === "url"}>Import from URL</a>
        <a className={method === "manual" ? "active" : ""} href={params.sourceUrl ? `/jobs/add?method=manual&sourceUrl=${encodeURIComponent(params.sourceUrl)}#manual` : "/jobs/add?method=manual#manual"} role="tab" aria-selected={method === "manual"}>Add manually</a>
      </div>

      {method === "url" ? <section className="card jobEntryCard addJobCard">
        <div className="cardHeader"><div><h2>Import from job listing URLs</h2><p>Add one or more public links. They are sent together as one batch.</p></div></div>
        <JobUrlInspectionForm />
      </section> : null}

      {method === "manual" ? <section id="manual" className="card jobEntryCard addJobCard">
        <div className="cardHeader"><div><h2>Add a vacancy manually</h2><p>Enter the essential details and paste the job description.</p></div></div>
        <JobIngestForm initialSourceUrl={params.sourceUrl || ""} />
      </section> : null}
    </AppShell>
  );
}
