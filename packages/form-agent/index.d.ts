export type FormTrust = "verified" | "proposed" | "user_required";
export type FormFieldStatus = "ready" | "needs_approval" | "needs_user" | "unsupported" | "already_complete";
export type FormControlType = "text" | "textarea" | "number" | "select" | "combobox" | "radio" | "checkbox" | "date" | "file" | "tags" | "other";
export type PagePurpose = "authentication" | "candidate_details" | "employment" | "education" | "skills" | "documents" | "screening" | "voluntary_disclosure" | "review" | "confirmation" | "unknown";

export type ObservedControl = {
  fieldKey: string;
  label: string;
  name?: string | null;
  id?: string | null;
  role?: string | null;
  controlType: FormControlType | "button";
  required?: boolean;
  disabled?: boolean;
  visible?: boolean;
  currentValue?: unknown;
  hasValue?: boolean;
  options?: Array<{ label: string; value: string }>;
  locator?: Record<string, unknown>;
  sensitive?: boolean;
  autocomplete?: string | null;
  placeholder?: string | null;
  optionLabel?: string | null;
  optionValue?: string | null;
};

export type PageObservation = {
  url: string;
  title: string;
  bodyText?: string;
  ariaSnapshot?: string | null;
  controls: ObservedControl[];
  flags?: { captcha?: boolean; mfa?: boolean; authentication?: boolean };
  fingerprint?: string;
};

export type ApprovedFormContext = {
  candidate?: Record<string, unknown>;
  facts?: Array<{ id?: string; factKey: string; value: unknown; verified?: boolean }>;
  answers?: Array<{ id?: string; questionKey?: string | null; questionText: string; answerText: string | null; trust: FormTrust; approved: boolean }>;
  salary?: { value?: number | null; currency?: string | null; approved?: boolean } | null;
  documents?: { cv?: { url?: string | null; filename?: string | null; versionId?: string | null }; coverLetter?: { url?: string | null; filename?: string | null; versionId?: string | null } | null };
  cvContent?: Record<string, unknown> | null;
  coverLetterContent?: string | null;
};

export type FormAgentPagePlan = {
  page_purpose: PagePurpose;
  page_confidence: number;
  fields: Array<{
    field_key: string;
    label: string;
    control_type: FormControlType;
    required: boolean;
    semantic_key: string | null;
    trust: FormTrust;
    status: FormFieldStatus;
    proposed_value?: unknown;
    provenance_ids: string[];
    notes?: string | null;
  }>;
  actions: Array<{
    action: "fill" | "select" | "toggle" | "upload" | "clear" | "navigate" | "none";
    target_key: string | null;
    value?: unknown;
    safe_without_new_user_approval: boolean;
  }>;
  must_pause: boolean;
  pause_reasons: string[];
  submission_detected: boolean;
  next_observation_required: boolean;
};

export function planAdaptivePage(observation: PageObservation, context: ApprovedFormContext): FormAgentPagePlan;
export function buildFinalReviewDiff(observation: PageObservation, plan: FormAgentPagePlan): { summary: Record<string, number>; items: Array<Record<string, unknown>> };
export function validatePagePlan(plan: FormAgentPagePlan): { ok: boolean; errors: string[] };
export function isDangerousSubmissionLabel(label: string): boolean;
export function isStartApplicationLabel(label: string): boolean;
