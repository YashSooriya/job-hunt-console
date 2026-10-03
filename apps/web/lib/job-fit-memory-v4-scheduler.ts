type MemoryFitSchedulerEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
  JOB_POOL_SCHEDULER_SECRET?: string;
};

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
/** Wake the service-only Memory-fit worker through the existing minute scheduler. */
export async function runJobFitMemoryV4Scheduler(
  env: MemoryFitSchedulerEnvironment,
  fetcher: typeof fetch = fetch,
  limit = 5,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("memory_fit_scheduler_limit_invalid");
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || !env.JOB_POOL_SCHEDULER_SECRET) {
    throw new Error("memory_fit_scheduler_not_configured");
  }
  const response = await fetcher(new URL("/functions/v1/job-pool-scheduler", env.NEXT_PUBLIC_SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`,
      "content-type": "application/json",
      "x-job-pool-scheduler-secret": env.JOB_POOL_SCHEDULER_SECRET,
    },
    body: JSON.stringify({ action: "memory_fit_advance", limit }),
    cache: "no-store",
  });
  const body = record(await response.json().catch(() => null));
  if (!response.ok || body.ok !== true) throw new Error(typeof body.error === "string" ? body.error : "memory_fit_scheduler_failed");
  return {
    claimed: Number(body.claimed || 0),
    outcomes: Array.isArray(body.outcomes) ? body.outcomes.map(record) : [],
  };
}
