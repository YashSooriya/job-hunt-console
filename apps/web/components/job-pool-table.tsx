"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ApplicationCreateButton } from "@/components/application-create-button";
import { JobAnalysisBatchControls } from "@/components/job-analysis-batch-controls";
import type { JobRecord, JobUserStatus, PreparationApplicationRecord } from "@/lib/types";

type SortKey = "discovered" | "posted" | "fit" | "salary" | "company" | "title" | "industry" | "location" | "closing";
type PoolView = "active" | "closing" | "expired" | "archived" | "closed" | "all";
type ManagementAction = "archive" | "restore" | "status";
type SortDirection = "asc" | "desc";

const PAGE_SIZE = 25;
const USER_STATUS_LABELS: Record<JobUserStatus, string> = {
  new: "New",
  reviewing: "Reviewing",
  interested: "Interested",
  not_interested: "Not interested",
  applied: "Applied",
  closed: "Closed",
};

function dateLabel(value: string | null) {
  if (!value) return "Date unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function postingAge(value: string | null) {
  if (!value) return "Unknown age";
  const posted = new Date(value).getTime();
  if (!Number.isFinite(posted)) return "Unknown age";
  const days = Math.max(0, Math.floor((Date.now() - posted) / 86400000));
  return `${days} day${days === 1 ? "" : "s"} since posting`;
}

function deadline(value: string | null) {
  if (!value) return { kind: "unknown", label: "No closing date" };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { kind: "unknown", label: "Date unavailable" };
  const day = (value.slice(0, 10) === value ? `${value}T00:00:00` : value.slice(0, 10) + "T00:00:00");
  const target = new Date(day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  const remaining = Math.ceil((target.getTime() - today.getTime()) / 86400000);
  if (remaining < 0) return { kind: "expired", label: `Expired ${dateLabel(value)}` };
  if (remaining === 0) return { kind: "soon", label: "Closes today" };
  if (remaining <= 7) return { kind: "soon", label: `Closes in ${remaining} day${remaining === 1 ? "" : "s"}` };
  return { kind: "open", label: dateLabel(value) };
}

function sourceLabel(source: string) {
  if (source === "chatgpt_url" || source === "chatgpt_direct") return "Imported from a listing";
  if (source === "openai_responses") return "Imported job";
  if (source === "chatgpt_mcp") return "Discovered by ChatGPT";
  return source === "manual" ? "Added manually" : source.replaceAll("_", " ");
}

function fitLabel(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Incomplete score";
  return `${(Math.max(0, Math.min(100, Number(value))) / 10).toFixed(1)}/10`;
}

function salaryValue(job: JobRecord) {
  return job.salaryMax ?? job.salaryMin;
}

function salaryLabel(job: JobRecord) {
  if (job.salaryText) return job.salaryText;
  if (job.salaryMin !== null && job.salaryMax !== null) return `${job.salaryCurrency} ${job.salaryMin.toLocaleString()}–${job.salaryMax.toLocaleString()}`;
  if (job.salaryMin !== null) return `${job.salaryCurrency} ${job.salaryMin.toLocaleString()}+`;
  if (job.salaryMax !== null) return `Up to ${job.salaryCurrency} ${job.salaryMax.toLocaleString()}`;
  return "Not listed";
}

function shortId(id: string) {
  return `JOB-${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function statusValue(job: JobRecord): JobUserStatus {
  return job.userStatus || "new";
}

function defaultDirection(key: SortKey): SortDirection {
  return ["company", "title", "industry", "location"].includes(key) ? "asc" : "desc";
}

function sortFromParam(value: string | undefined): SortKey {
  return ["discovered", "posted", "fit", "salary", "company", "title", "industry", "location", "closing"].includes(value || "")
    ? value as SortKey
    : "discovered";
}

function compareNullableNumber(left: number | null, right: number | null, direction: SortDirection) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function compareText(left: string | null, right: string | null, direction: SortDirection) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const result = left.localeCompare(right, "en", { sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

export function JobPoolTable({
  jobs,
  applications,
  analysisAvailable = true,
  initialSort,
  initialDirection,
}: {
  jobs: JobRecord[];
  applications: PreparationApplicationRecord[];
  analysisAvailable?: boolean;
  initialSort?: string;
  initialDirection?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [triage, setTriage] = useState("all");
  const [userStatus, setUserStatus] = useState("all");
  const [workMode, setWorkMode] = useState("all");
  const [source, setSource] = useState("all");
  const [poolView, setPoolView] = useState<PoolView>("active");
  const [industry, setIndustry] = useState("all");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [sort, setSort] = useState<SortKey>(() => sortFromParam(initialSort));
  const [direction, setDirection] = useState<SortDirection>(() => initialDirection === "asc" || initialDirection === "desc" ? initialDirection : defaultDirection(sortFromParam(initialSort)));
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<JobUserStatus>("reviewing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; ids: string[]; action: ManagementAction } | null>(null);
  const applicationByJob = useMemo(() => new Map(applications.map((item) => [item.jobId, item])), [applications]);
  const activeJobs = jobs.filter((job) => !job.archivedAt);
  const pendingAnalysisIds = activeJobs.filter((job) => (job.analysisStatus || (job.analysis ? "current" : "pending")) === "pending").map((job) => job.id);
  const outdatedAnalysisIds = activeJobs.filter((job) => job.analysisStatus === "outdated").map((job) => job.id);
  const sourceOptions = useMemo(() => [...new Set(jobs.map((job) => job.discoverySource))].sort(), [jobs]);
  const industryOptions = useMemo(() => [...new Set(jobs.map((job) => job.industry).filter((item): item is string => Boolean(item)))].sort(), [jobs]);
  const workModeOptions = useMemo(() => [...new Set(jobs.map((job) => job.workMode).filter((item): item is string => Boolean(item)))].sort(), [jobs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const result = jobs.filter((job) => {
      const haystack = `${job.company} ${job.title} ${job.location || ""} ${job.industry || ""} ${job.externalJobId || ""}`.toLowerCase();
      const close = deadline(job.closesAt);
      const archived = Boolean(job.archivedAt);
      const status = statusValue(job);
      const analysisStatus = job.analysisStatus || (job.analysis ? "current" : "pending");
      const currentTriage = analysisStatus === "current" ? job.analysis?.triage || job.triage : null;
      const viewMatches = poolView === "all"
        || (poolView === "active" && !archived && status !== "closed" && close.kind !== "expired")
        || (poolView === "closing" && !archived && status !== "closed" && close.kind === "soon")
        || (poolView === "expired" && !archived && close.kind === "expired")
        || (poolView === "archived" && archived)
        || (poolView === "closed" && !archived && status === "closed");
      return (!needle || haystack.includes(needle))
        && (triage === "all"
          || (triage === "pending" && analysisStatus === "pending")
          || (triage === "outdated" && analysisStatus === "outdated")
          || (triage !== "pending" && triage !== "outdated" && currentTriage === triage))
        && (userStatus === "all" || status === userStatus)
        && (workMode === "all" || (job.workMode || "") === workMode)
        && (source === "all" || job.discoverySource === source)
        && (industry === "all" || job.industry === industry)
        && viewMatches;
    });
    return result.sort((left, right) => {
      if (sort === "fit") {
        const leftCurrent = (left.analysisStatus || (left.analysis ? "current" : "pending")) === "current";
        const rightCurrent = (right.analysisStatus || (right.analysis ? "current" : "pending")) === "current";
        return compareNullableNumber(leftCurrent ? left.analysis?.fitScore ?? null : null, rightCurrent ? right.analysis?.fitScore ?? null : null, direction);
      }
      if (sort === "salary") return compareNullableNumber(salaryValue(left), salaryValue(right), direction);
      if (sort === "company") return compareText(left.company, right.company, direction) || compareText(left.title, right.title, direction);
      if (sort === "title") return compareText(left.title, right.title, direction);
      if (sort === "industry") return compareText(left.industry, right.industry, direction);
      if (sort === "location") return compareText(left.location, right.location, direction);
      if (sort === "posted") return compareNullableNumber(Date.parse(left.postedAt || "") || null, Date.parse(right.postedAt || "") || null, direction);
      if (sort === "closing") return compareNullableNumber(Date.parse(left.closesAt || "") || null, Date.parse(right.closesAt || "") || null, direction);
      return compareNullableNumber(Date.parse(left.discoveredAt || "") || null, Date.parse(right.discoveredAt || "") || null, direction);
    });
  }, [direction, industry, jobs, poolView, query, sort, source, triage, userStatus, workMode]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const visibleIds = visible.map((job) => job.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const updateFilter = <T extends string>(setter: (value: T) => void, value: T) => { setter(value); setPage(1); setSelectedIds([]); };

  function saveSort(nextSort: SortKey, nextDirection: SortDirection) {
    setSort(nextSort);
    setDirection(nextDirection);
    const url = new URL(window.location.href);
    url.searchParams.set("sort", nextSort);
    url.searchParams.set("direction", nextDirection);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function requestSort(key: SortKey) {
    if (sort === key) saveSort(key, direction === "asc" ? "desc" : "asc");
    else saveSort(key, defaultDirection(key));
  }

  async function manage(ids: string[], action: ManagementAction, status?: JobUserStatus) {
    if (!ids.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/jobs/management", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action, status }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Unable to update these jobs.");
      setSelectedIds([]);
      if (action === "archive") setNotice({ message: `${ids.length} job${ids.length === 1 ? "" : "s"} removed from the active pool.`, ids, action });
      else if (action === "restore") setNotice({ message: `${ids.length} job${ids.length === 1 ? "" : "s"} restored to the active pool.`, ids, action });
      else setNotice({ message: `Updated ${ids.length} job${ids.length === 1 ? "" : "s"} to ${USER_STATUS_LABELS[status || "new"]}.`, ids, action });
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update these jobs.");
    } finally {
      setBusy(false);
    }
  }

  function toggleVisible() {
    setSelectedIds((current) => allVisibleSelected
      ? current.filter((id) => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])]);
  }

  function clearFilters() {
    setQuery("");
    setTriage("all");
    setUserStatus("all");
    setWorkMode("all");
    setSource("all");
    setIndustry("all");
    setPoolView("active");
    setPage(1);
    setSelectedIds([]);
  }

  const sortQuery = `?sort=${encodeURIComponent(sort)}&direction=${direction}`;
  const sortHeader = (label: string, key: SortKey) => (
    <th aria-sort={sort === key ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button className="sortHeaderButton" type="button" onClick={() => requestSort(key)}>{label}{sort === key ? <span aria-hidden="true">{direction === "asc" ? " ↑" : " ↓"}</span> : null}</button>
    </th>
  );

  return (
    <section className="card tableCard jobPoolCard">
      <div className="cardHeader jobPoolHeader">
        <div><h2>Job pool</h2><p>{filtered.length} {filtered.length === 1 ? "job" : "jobs"} match these filters.</p></div>
        <span className="badge muted">{jobs.filter((job) => !job.archivedAt).length} in pool · {jobs.filter((job) => job.archivedAt).length} removed</span>
      </div>
      <div className={`jobPoolControls${showMoreFilters ? " showMore" : ""}`} role="search" aria-label="Filter job pool">
        <label className="jobPoolSearch"><span>Search jobs</span><input className="input" value={query} onChange={(event) => updateFilter(setQuery, event.target.value)} placeholder="Search company, role, location…" /></label>
        <label><span>Show</span><select className="input" value={poolView} onChange={(event) => updateFilter(setPoolView, event.target.value as PoolView)}><option value="active">Open jobs</option><option value="closing">Closing soon</option><option value="expired">Expired listings</option><option value="closed">Closed by me</option><option value="archived">Archived</option><option value="all">All jobs</option></select></label>
        <label><span>My status</span><select className="input" value={userStatus} onChange={(event) => updateFilter(setUserStatus, event.target.value)}><option value="all">All statuses</option>{Object.entries(USER_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="jobPoolExtraFilter"><span>Analysis</span><select className="input" value={triage} onChange={(event) => updateFilter(setTriage, event.target.value)}><option value="all">All decisions</option><option value="auto_prepare">Auto-prepare</option><option value="recommend">Recommended</option><option value="maybe">Maybe</option><option value="reject">Rejected</option><option value="pending">Analysis pending</option><option value="outdated">Outdated analysis</option></select></label>
        <label className="jobPoolExtraFilter"><span>Work mode</span><select className="input" value={workMode} onChange={(event) => updateFilter(setWorkMode, event.target.value)}><option value="all">All work modes</option>{workModeOptions.map((item) => <option value={item} key={item}>{item.replaceAll("_", " ")}</option>)}</select></label>
        <label className="jobPoolExtraFilter"><span>Industry</span><select className="input" value={industry} onChange={(event) => updateFilter(setIndustry, event.target.value)}><option value="all">All industries</option>{industryOptions.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label className="jobPoolExtraFilter"><span>Source</span><select className="input" value={source} onChange={(event) => updateFilter(setSource, event.target.value)}><option value="all">All sources</option>{sourceOptions.map((item) => <option value={item} key={item}>{sourceLabel(item)}</option>)}</select></label>
        <label><span>Sort</span><select className="input" value={sort} onChange={(event) => saveSort(event.target.value as SortKey, defaultDirection(event.target.value as SortKey))}><option value="discovered">Newest added</option><option value="posted">Newest posted</option><option value="closing">Closing date</option><option value="fit">Fit score</option><option value="salary">Salary</option><option value="company">Company</option><option value="title">Role</option><option value="industry">Industry</option><option value="location">Location</option></select></label>
        <button className="secondaryButton jobPoolMoreFilters" type="button" aria-expanded={showMoreFilters} onClick={() => setShowMoreFilters((value) => !value)}>{showMoreFilters ? "Fewer filters" : "More filters"}</button>
        <button className="secondaryButton jobPoolClearButton" type="button" onClick={clearFilters}>Clear filters</button>
      </div>
      <div className={`jobPoolBulkBar${selectedIds.length ? " hasSelection" : ""}`}>
        <label className="selectVisibleLabel"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} /> Select visible</label>
        <span>{selectedIds.length} selected</span>
        <label><span className="srOnly">Set selected jobs’ status</span><select className="input" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as JobUserStatus)}>{Object.entries(USER_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="secondaryButton" type="button" disabled={busy || !selectedIds.length} onClick={() => void manage(selectedIds, "status", bulkStatus)}>Set status</button>
        <button className="secondaryButton" type="button" disabled={busy || !selectedIds.length} onClick={() => void manage(selectedIds, "archive")}>Remove selected</button>
        <button className="secondaryButton" type="button" disabled={busy || !selectedIds.length} onClick={() => void manage(selectedIds, "restore")}>Restore selected</button>
      </div>
      {analysisAvailable
        ? <JobAnalysisBatchControls pendingIds={pendingAnalysisIds} outdatedIds={outdatedAnalysisIds} selectedIds={selectedIds} />
        : <p className="jobAnalysisHint">Connect your account database to analyse saved listings. Local demo data is read-only.</p>}
      {notice ? <div className="jobPoolNotice" role="status"><span>{notice.message}</span>{notice.action === "archive" ? <button className="textButton" type="button" disabled={busy} onClick={() => void manage(notice.ids, "restore")}>Undo</button> : notice.action === "restore" ? <button className="textButton" type="button" disabled={busy} onClick={() => void manage(notice.ids, "archive")}>Undo</button> : null}</div> : null}
      {error ? <div className="formError jobPoolError" role="alert">{error}</div> : null}
      {visible.length ? <div className="tableWrap"><table className="dataTable jobPoolTable"><thead><tr>
        <th><span className="srOnly">Select</span></th>
        {sortHeader("Job", "title")}{sortHeader("Salary", "salary")}{sortHeader("Location", "location")}{sortHeader("Posted", "posted")}{sortHeader("Fit", "fit")}<th>My status</th><th>Actions</th>
      </tr></thead><tbody>
        {visible.map((job) => {
          const application = applicationByJob.get(job.id);
          const close = deadline(job.closesAt);
          const analysisStatus = job.analysisStatus || (job.analysis ? "current" : "pending");
          const disabledReason = !job.analysis || analysisStatus === "pending"
            ? "JobHuntAI fit analysis is pending. Analyse the listing before preparing an application."
            : analysisStatus === "outdated"
              ? "JobHuntAI fit analysis is outdated. Refresh it against your current profile before preparing an application."
            : job.analysis.eligibility === "ineligible"
              ? "This vacancy is marked ineligible for application preparation."
              : null;
          const selected = selectedIds.includes(job.id);
          return <tr key={job.id}>
            <td><input type="checkbox" aria-label={`Select ${job.title} at ${job.company}`} checked={selected} onChange={() => setSelectedIds((current) => selected ? current.filter((id) => id !== job.id) : [...current, job.id])} /></td>
            <td><a className="textLink jobPoolRole" href={`/jobs/${job.id}${sortQuery}`}>{job.title}</a><span className="tableSubtext">{job.company}</span><span className="jobReference" title={job.id}>{shortId(job.id)}</span>{job.sourceUrl ? <a className="tableSubtext tableLink" href={job.sourceUrl} target="_blank" rel="noreferrer">Open listing ↗</a> : null}<details className="jobRowDetails"><summary>More details</summary><span>Industry: {job.industry || "Not classified"}</span><span>Closing: {close.label}</span><span>Source: {sourceLabel(job.discoverySource)}</span>{job.externalJobId ? <span>Employer ID: {job.externalJobId}</span> : null}</details></td>
            <td><strong>{salaryLabel(job)}</strong><span className={`tableSubtext ${job.salarySource === "chatgpt_estimate" ? "estimateText" : ""}`}>{job.salarySource === "chatgpt_estimate" ? `ChatGPT estimate${job.salaryConfidence ? ` · ${job.salaryConfidence}` : ""}` : job.salarySource === "advertised" ? "Advertised" : "Not available"}</span></td>
            <td>{job.location || "Not supplied"}{job.workMode ? <span className="tableSubtext">{job.workMode}</span> : null}</td>
            <td><strong>{postingAge(job.postedAt)}</strong><span className="tableSubtext">{dateLabel(job.postedAt)}</span></td>
            <td>{job.analysis && analysisStatus === "current" ? <><strong>{fitLabel(job.analysis.fitScore)}</strong><span className={`badge triage-${job.analysis.triage}`}>{job.analysis.triage.replaceAll("_", " ")}</span></> : <span className="mutedText">{analysisStatus === "outdated" ? "Refresh analysis" : "Analysis pending"}</span>}</td>
            <td><label className="srOnly" htmlFor={`job-status-${job.id}`}>My status for {job.title}</label><select id={`job-status-${job.id}`} className="input jobStatusSelect" value={statusValue(job)} disabled={busy} onChange={(event) => void manage([job.id], "status", event.target.value as JobUserStatus)}>{Object.entries(USER_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{job.archivedAt ? <span className="tableSubtext">Archived {dateLabel(job.archivedAt)}</span> : null}</td>
            <td className="jobPoolActions"><div className="jobPoolActionButtons"><ApplicationCreateButton jobId={job.id} existingApplicationId={application?.id || null} disabledReason={disabledReason || (job.archivedAt ? "Restore this vacancy to prepare an application." : null)} actionLabel="Choose to apply" />{job.analysis?.triage === "reject" && !disabledReason ? <span className="tableSubtext">Low fit is guidance; you can still choose to apply.</span> : null}<a className="secondaryButton" href={`/jobs/${job.id}${sortQuery}&edit=1`}>Edit</a><button className="secondaryButton" type="button" disabled={busy} onClick={() => void manage([job.id], job.archivedAt ? "restore" : "archive")}>{job.archivedAt ? "Restore" : "Remove from pool"}</button></div></td>
          </tr>;
        })}
      </tbody></table></div> : <div className="emptyState">{jobs.length ? "No vacancies match these filters." : "No vacancies yet. Import a listing URL, add one manually, or run Search jobs now."}</div>}
      {filtered.length > PAGE_SIZE ? <div className="jobPoolPagination"><span>Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}</span><div className="buttonRow"><button className="secondaryButton" type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span className="paginationPage">Page {currentPage} of {pageCount}</span><button className="secondaryButton" type="button" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next</button></div></div> : null}
    </section>
  );
}
