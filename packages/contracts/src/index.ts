export type CvFamily = "simulation_cae" | "scientific_software" | "quantitative_data" | "motorsport";
export type AnswerTrust = "verified" | "proposed" | "user_required";
export type EligibilityState = "eligible" | "eligible_with_concerns" | "unknown" | "ineligible";
export type JobTriage = "auto_prepare" | "recommend" | "maybe" | "reject";

export const FIT_WEIGHTS = {
  technical_capability: 0.30,
  evidence_strength: 0.20,
  seniority_fit: 0.15,
  domain_fit: 0.15,
  role_type_fit: 0.10,
  qualifications: 0.10,
} as const;

export const PRIORITY_WEIGHTS = {
  fit: 0.35,
  screening_probability: 0.20,
  compensation_value: 0.15,
  geography: 0.10,
  posting_freshness: 0.10,
  application_effort: 0.05,
  closing_urgency: 0.05,
} as const;

export const APPLICATION_STATES = [
  "discovered","triaged","shortlisted","preparing","ready_for_review","revision_requested",
  "content_approved","form_in_progress","form_needs_user","final_review","approved_for_submission",
  "submitted","awaiting_response","assessment","interview","offer","rejected","withdrawn","expired"
] as const;
export type ApplicationState = typeof APPLICATION_STATES[number];

export type FormPagePurpose = "authentication" | "candidate_details" | "employment" | "education" | "skills" | "documents" | "screening" | "voluntary_disclosure" | "review" | "confirmation" | "unknown";
export type FormControlType = "text" | "textarea" | "number" | "select" | "combobox" | "radio" | "checkbox" | "date" | "file" | "tags" | "other";
export type FormFieldStatus = "ready" | "needs_approval" | "needs_user" | "unsupported" | "already_complete";
