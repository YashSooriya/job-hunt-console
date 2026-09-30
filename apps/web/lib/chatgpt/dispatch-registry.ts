export const DISPATCH_SCHEMA_VERSION = "1.0.0" as const;

export const DISPATCH_STATES = [
  "queued",
  "claimed_by_extension",
  "opening_chatgpt",
  "composer_ready",
  "sent",
  "acknowledged_by_mcp",
  "running",
  "completed",
  "user_required",
  "failed",
  "expired",
  "cancelled",
] as const;

export type DispatchState = typeof DISPATCH_STATES[number];

export const DISPATCH_ACTION_TYPES = [
  "job.inspect_url",
  "jobs.search.manual",
  "jobs.analyse_selected",
  "documents.cv.create",
  "documents.cover_letter.create",
  "emails.process_now",
  "tracker.sync_now",
  "profile.background",
  "bridge.diagnostic",
] as const;

export type DispatchActionType = typeof DISPATCH_ACTION_TYPES[number];

export type DispatchSubjectRefs = Record<string, unknown>;

export type DispatchActionDescriptor = {
  actionType: DispatchActionType;
  actionVersion: string;
  displayTitle: string;
  maximumBatchSize: number;
  allowedEffects: readonly string[];
  confirmationPolicy: string;
  expectedOutputs: readonly string[];
  timeoutSeconds: number;
  retryPolicy: string;
};

export const DISPATCH_ACTIONS: Record<DispatchActionType, DispatchActionDescriptor> = {
  "job.inspect_url": {
    actionType: "job.inspect_url",
    actionVersion: "1.0.0",
    displayTitle: "Inspect a job listing",
    maximumBatchSize: 1,
    allowedEffects: ["read_research", "internal_job_data_update"],
    confirmationPolicy: "no_external_commitment",
    expectedOutputs: ["job_id", "snapshot_id"],
    timeoutSeconds: 900,
    retryPolicy: "at_most_once_after_ambiguous_delivery",
  },
  "jobs.search.manual": {
    actionType: "jobs.search.manual",
    actionVersion: "1.0.0",
    displayTitle: "Run a manual job search",
    maximumBatchSize: 1,
    allowedEffects: ["read_research", "internal_job_data_update"],
    confirmationPolicy: "no_external_commitment",
    expectedOutputs: ["jobs_checked", "jobs_discovered", "jobs_accepted"],
    timeoutSeconds: 1800,
    retryPolicy: "idempotent_search_writes",
  },
  "jobs.analyse_selected": {
    actionType: "jobs.analyse_selected",
    actionVersion: "1.0.0",
    displayTitle: "Analyse selected jobs",
    maximumBatchSize: 20,
    allowedEffects: ["read_research", "internal_job_data_update"],
    confirmationPolicy: "no_external_commitment",
    expectedOutputs: ["analysis_ids"],
    timeoutSeconds: 1200,
    retryPolicy: "idempotent_analysis_writes",
  },
  "documents.cv.create": {
    actionType: "documents.cv.create",
    actionVersion: "1.0.0",
    displayTitle: "Create CV drafts",
    maximumBatchSize: 10,
    allowedEffects: ["internal_draft_creation"],
    confirmationPolicy: "draft_only_needs_review",
    expectedOutputs: ["document_version_ids"],
    timeoutSeconds: 1800,
    retryPolicy: "idempotent_draft_versions",
  },
  "documents.cover_letter.create": {
    actionType: "documents.cover_letter.create",
    actionVersion: "1.0.0",
    displayTitle: "Create cover-letter drafts",
    maximumBatchSize: 10,
    allowedEffects: ["internal_draft_creation"],
    confirmationPolicy: "draft_only_needs_review",
    expectedOutputs: ["document_version_ids"],
    timeoutSeconds: 1800,
    retryPolicy: "idempotent_draft_versions",
  },
  "emails.process_now": {
    actionType: "emails.process_now",
    actionVersion: "1.0.0",
    displayTitle: "Process pending job-related emails",
    maximumBatchSize: 25,
    allowedEffects: ["internal_job_data_update"],
    confirmationPolicy: "no_external_commitment",
    expectedOutputs: ["processed_email_ids", "needs_user_count"],
    timeoutSeconds: 900,
    retryPolicy: "idempotent_email_classification",
  },
  "tracker.sync_now": {
    actionType: "tracker.sync_now",
    actionVersion: "1.0.0",
    displayTitle: "Synchronise the application tracker",
    maximumBatchSize: 1,
    allowedEffects: ["user_configured_tracker_synchronisation"],
    confirmationPolicy: "user_configured_destination_only",
    expectedOutputs: ["rows_synced", "tracker_status"],
    timeoutSeconds: 600,
    retryPolicy: "idempotent_tracker_sync",
  },
  "profile.background": {
    actionType: "profile.background",
    actionVersion: "1.0.0",
    displayTitle: "Update professional background",
    maximumBatchSize: 1,
    allowedEffects: ["internal_profile_memory_update"],
    confirmationPolicy: "no_external_commitment",
    expectedOutputs: ["memory_update_status"],
    timeoutSeconds: 900,
    retryPolicy: "at_most_once_after_ambiguous_delivery",
  },
  "bridge.diagnostic": {
    actionType: "bridge.diagnostic",
    actionVersion: "1.0.0",
    displayTitle: "Run a bridge diagnostic",
    maximumBatchSize: 1,
    allowedEffects: ["read_research"],
    confirmationPolicy: "diagnostic_only",
    expectedOutputs: ["diagnostic_status"],
    timeoutSeconds: 300,
    retryPolicy: "no_automatic_resend_after_ambiguous_delivery",
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} contains unsupported field '${key}'.`);
}

function assertUuidList(value: unknown, key: string, maximum: number) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum || value.some((item) => !isUuid(item))) {
    throw new Error(`${key} must contain one to ${maximum} owned UUIDs.`);
  }
}

export function validateDispatchSubjectRefs(actionType: DispatchActionType, input: unknown): DispatchSubjectRefs {
  assertPlainObject(input, "subject_refs");
  const descriptor = DISPATCH_ACTIONS[actionType];
  switch (actionType) {
    case "job.inspect_url":
      assertOnlyKeys(input, ["inspection_id"], "subject_refs");
      if (!isUuid(input.inspection_id)) throw new Error("inspection_id must be a UUID.");
      return { inspection_id: input.inspection_id };
    case "jobs.analyse_selected":
      assertOnlyKeys(input, ["job_ids"], "subject_refs");
      assertUuidList(input.job_ids, "job_ids", descriptor.maximumBatchSize);
      return { job_ids: input.job_ids };
    case "documents.cv.create":
    case "documents.cover_letter.create":
      assertOnlyKeys(input, ["application_ids"], "subject_refs");
      assertUuidList(input.application_ids, "application_ids", descriptor.maximumBatchSize);
      return { application_ids: input.application_ids };
    case "emails.process_now":
      assertOnlyKeys(input, ["email_ids"], "subject_refs");
      if (input.email_ids !== undefined) assertUuidList(input.email_ids, "email_ids", descriptor.maximumBatchSize);
      return input.email_ids === undefined ? {} : { email_ids: input.email_ids };
    case "jobs.search.manual":
    case "tracker.sync_now":
    case "profile.background":
    case "bridge.diagnostic":
      assertOnlyKeys(input, [], "subject_refs");
      return {};
  }
}

export function getDispatchDescriptor(actionType: string): DispatchActionDescriptor {
  if (!DISPATCH_ACTION_TYPES.includes(actionType as DispatchActionType)) throw new Error("Unsupported dispatch action type.");
  return DISPATCH_ACTIONS[actionType as DispatchActionType];
}

export function validateIdempotencyKey(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error("idempotency_key must be 1-200 letters, numbers, dots, underscores, colons, or hyphens.");
  }
  return value;
}
