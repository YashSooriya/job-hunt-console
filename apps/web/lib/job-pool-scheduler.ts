export type JobPoolSchedulerEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  JOB_POOL_SCHEDULER_SECRET: string;
  JOBHUNT_M03_TEST_MODE?: string;
  JOBHUNT_M03_TEST_GOOGLE_API_BASE?: string;
  JOB_FIT_V3_MODE?: string;
  JOB_FIT_V3_CANARY_USER_IDS?: string;
};

type DriveCheckClaim = {
  user_id: string;
  lease_id: string;
  spreadsheet_id: string;
  expected_drive_file_version: string;
  source_revision: number;
  refresh_token: string | null;
};

type DriveCheckResult = {
  user_id: string;
  lease_id: string;
  source_revision: number;
  observed_version: string | null;
  error: "google_reconnect_required" | "google_sheet_not_accessible" | "google_sheet_check_unavailable" | null;
};

const FUNCTIONS_PATH = "/functions/v1/job-pool-scheduler";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const MAX_PARALLEL_CHECKS = 5;

function googleEndpoint(env: JobPoolSchedulerEnvironment, productionUrl: string, localPath: string) {
  const override = env.JOBHUNT_M03_TEST_GOOGLE_API_BASE;
  if (!override) return productionUrl;
  if (env.JOBHUNT_M03_TEST_MODE !== "1") throw new Error("The local Google provider is available only in explicit M03 test mode.");
  let base: URL;
  try { base = new URL(override); }
  catch { throw new Error("The M03 Google test provider URL is invalid."); }
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port || base.pathname !== "/") {
    throw new Error("The M03 Google test provider must bind to 127.0.0.1.");
  }
  return new URL(localPath, base).toString();
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

async function functionRequest(env: JobPoolSchedulerEnvironment, fetcher: typeof fetch, action: "claim" | "finish", payload: Record<string, unknown> = {}) {
  const response = await fetcher(new URL(FUNCTIONS_PATH, env.NEXT_PUBLIC_SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}`,
      "content-type": "application/json",
      "x-job-pool-scheduler-secret": env.JOB_POOL_SCHEDULER_SECRET,
    },
    body: JSON.stringify({ action, ...payload }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`job_pool_scheduler_function_${response.status}`);
  const body = record(await response.json());
  if (body.ok !== true) throw new Error("job_pool_scheduler_function_failed");
  return body;
}

async function googleAccessToken(claim: DriveCheckClaim, env: JobPoolSchedulerEnvironment, fetcher: typeof fetch) {
  if (!claim.refresh_token) throw new Error("google_reconnect_required");
  const response = await fetcher(googleEndpoint(env, GOOGLE_TOKEN_URL, "/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: claim.refresh_token,
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  if (response.status === 400 || response.status === 401) throw new Error("google_reconnect_required");
  if (!response.ok) throw new Error("google_sheet_check_unavailable");
  const payload = record(await response.json());
  if (typeof payload.access_token !== "string" || !payload.access_token) throw new Error("google_sheet_check_unavailable");
  return payload.access_token;
}

async function driveVersion(claim: DriveCheckClaim, accessToken: string, env: JobPoolSchedulerEnvironment, fetcher: typeof fetch) {
  const drivePath = `/drive/v3/files/${encodeURIComponent(claim.spreadsheet_id)}?fields=id,mimeType,version,trashed`;
  const response = await fetcher(googleEndpoint(env, `${DRIVE_FILES_URL}/${encodeURIComponent(claim.spreadsheet_id)}?fields=id,mimeType,version,trashed`, drivePath), {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("google_reconnect_required");
  if (response.status === 403 || response.status === 404) throw new Error("google_sheet_not_accessible");
  if (!response.ok) throw new Error("google_sheet_check_unavailable");
  const raw = await response.text();
  // Google Drive exposes version as an int64 JSON number; quote its original
  // digits before JSON.parse so large versions are never rounded by JS.
  const lossless = raw.replace(/("version"\s*:\s*)(\d+)/g, '$1"$2"');
  let file: Record<string, any>;
  try { file = record(JSON.parse(lossless)); }
  catch { throw new Error("google_sheet_check_unavailable"); }
  if (file.id !== claim.spreadsheet_id || file.trashed === true
    || file.mimeType !== "application/vnd.google-apps.spreadsheet" || file.version == null) {
    throw new Error("google_sheet_not_accessible");
  }
  return String(file.version);
}

async function verifyOne(claim: DriveCheckClaim, env: JobPoolSchedulerEnvironment, fetcher: typeof fetch): Promise<DriveCheckResult> {
  const result: DriveCheckResult = {
    user_id: claim.user_id,
    lease_id: claim.lease_id,
    source_revision: claim.source_revision,
    observed_version: null,
    error: null,
  };
  try {
    if (!claim.user_id || !claim.lease_id || !Number.isSafeInteger(claim.source_revision)
      || !claim.spreadsheet_id || !claim.expected_drive_file_version) {
      throw new Error("google_sheet_check_unavailable");
    }
    const token = await googleAccessToken(claim, env, fetcher);
    result.observed_version = await driveVersion(claim, token, env, fetcher);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    result.error = code === "google_reconnect_required" || code === "google_sheet_not_accessible"
      ? code
      : "google_sheet_check_unavailable";
  }
  return result;
}

async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) {
  const output: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

/**
 * Scheduled searches call this first. It reads only Drive file metadata, so a
 * healthy workbook costs one small Google API request per due user; any
 * changed version is recorded as drift and the SQL scheduler fails closed.
 */
export async function runJobPoolDrivePreflight(
  env: JobPoolSchedulerEnvironment,
  fetcher: typeof fetch = fetch,
) {
  const claimBody = await functionRequest(env, fetcher, "claim");
  const claims = Array.isArray(claimBody.checks) ? claimBody.checks.map((item: unknown) => record(item) as DriveCheckClaim) : [];
  if (!claims.length) return { claimed: 0, verified: 0, mismatched: 0, unavailable: 0 };

  const results = await mapBounded(claims, MAX_PARALLEL_CHECKS, (claim) => verifyOne(claim, env, fetcher));
  const finishBody = await functionRequest(env, fetcher, "finish", { results });
  const outcomes = Array.isArray(finishBody.outcomes) ? finishBody.outcomes : [];
  const verified = outcomes.filter((outcome: unknown) => record(outcome).ok === true).length;
  const mismatched = outcomes.filter((outcome: unknown) => record(outcome).reason === "sheet_changed").length;
  return {
    claimed: claims.length,
    verified,
    mismatched,
    unavailable: Math.max(0, claims.length - verified - mismatched),
  };
}
