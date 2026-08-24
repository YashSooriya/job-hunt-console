import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { getLocalJobs, getLocalPreparationApplications, saveLocalApplicationFromJob } from "@/lib/data/local";

export async function createApplicationFromJob(
  jobId: string,
  origin: "manual" | "auto_prepare" = "manual"
): Promise<{ applicationId: string; created: boolean; source: "supabase" | "local_snapshot" }> {
  const mode = getDataMode();

  if (isSupabaseConfigured() && mode !== "local") {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("create_application_from_job", {
      p_job_id: jobId,
      p_origin: origin,
    });
    if (error) throw error;
    const result = data as any;
    if (!result?.application_id) throw new Error("Application creation returned no application ID.");
    return { applicationId: result.application_id, created: Boolean(result.created), source: "supabase" };
  }

  const [jobs, applications] = await Promise.all([getLocalJobs(), getLocalPreparationApplications()]);
  const job = jobs.records.find((item) => item.id === jobId);
  if (!job) throw new Error("Job not found.");
  const existing = applications.records.find((item) => item.jobId === jobId);
  const record = existing || await saveLocalApplicationFromJob(job, origin);
  return { applicationId: record.id, created: !existing, source: "local_snapshot" };
}
