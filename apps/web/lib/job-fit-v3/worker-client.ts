import { getCloudflareContext } from "@opennextjs/cloudflare";

type RuntimeBindings = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
  JOB_POOL_SCHEDULER_SECRET?: string;
  JOB_FIT_V3_MODE?: string;
  JOB_FIT_V3_CANARY_USER_IDS?: string;
};

export function jobFitRuntimeBindings(): RuntimeBindings {
  let bindings: RuntimeBindings = {};
  try { bindings = getCloudflareContext({ async: false }).env as unknown as RuntimeBindings; }
  catch { /* Next local/dev uses process.env rather than the Worker bindings. */ }
  return {
    NEXT_PUBLIC_SUPABASE_URL: bindings.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: bindings.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    JOB_POOL_SCHEDULER_SECRET: bindings.JOB_POOL_SCHEDULER_SECRET || process.env.JOB_POOL_SCHEDULER_SECRET,
    JOB_FIT_V3_MODE: bindings.JOB_FIT_V3_MODE || process.env.JOB_FIT_V3_MODE,
    JOB_FIT_V3_CANARY_USER_IDS: bindings.JOB_FIT_V3_CANARY_USER_IDS || process.env.JOB_FIT_V3_CANARY_USER_IDS,
  };
}

export function jobFitV3Enabled(userId: string, mode: string | undefined, canaryIds: string | undefined) {
  if (mode === "enabled") return true;
  if (mode !== "canary") return false;
  return (canaryIds || "").split(",").map((value) => value.trim()).filter(Boolean).includes(userId);
}

export async function callJobFitWorker(payload: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  const env = jobFitRuntimeBindings();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || !env.JOB_POOL_SCHEDULER_SECRET) {
    throw new Error("The trusted V3 fit worker is not configured.");
  }
  const response = await fetcher(new URL("/functions/v1/job-pool-scheduler", env.NEXT_PUBLIC_SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`,
      "content-type": "application/json",
      "x-job-pool-scheduler-secret": env.JOB_POOL_SCHEDULER_SECRET,
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok || body?.ok !== true) throw new Error(typeof body?.error === "string" ? body.error : "The trusted V3 fit worker could not save progress.");
  return body;
}
