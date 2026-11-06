export type OnboardingReadinessInput = {
  onboarding: any;
  facts: any[];
  evidence: any[];
  extractionProposals: any[];
  education: any[];
  employment: any[];
  skills: any[];
  projects: any[];
  publications: any[];
  cvFamilies: any[];
  sourceDocuments: any[];
  preferences: Record<string, any>;
};

export function fallbackReadiness(input: OnboardingReadinessInput) {
  const pendingReview = [
    ...input.facts,
    ...input.evidence,
    ...input.extractionProposals,
    ...input.education,
    ...input.employment,
    ...input.skills,
    ...input.projects,
    ...input.publications,
  ].filter((item) => item.verification_status === "needs_review").length;
  const history = input.education.filter((item) => item.verification_status === "verified").length
    + input.employment.filter((item) => item.verification_status === "verified").length;
  const skills = input.skills.filter((item) => item.verification_status === "verified").length;
  const evidence = input.evidence.filter((item) => item.verification_status === "verified").length;
  const workAuthorisation = input.facts.some((item) => item.fact_key === "work_authorisation" && item.verification_status === "verified");
  const families = input.cvFamilies.filter((item) => item.enabled).length;
  const sourceDocuments = input.sourceDocuments.filter((item) => ["stored", "extracted"].includes(item.extraction_status)).length;
  const profileComplete = history > 0 && workAuthorisation;
  const profileReady = profileComplete && pendingReview === 0;
  const score = (profileComplete ? 70 : 0)
    + (sourceDocuments > 0 ? 20 : 0)
    + (pendingReview === 0 ? 10 : 0);

  return {
    ready: profileReady,
    activation_ready: profileReady,
    profile_complete: profileComplete,
    score,
    status: input.onboarding?.status || "in_progress",
    pending_review: pendingReview,
    history,
    skills,
    verified_evidence: evidence,
    work_authorisation: workAuthorisation,
    // Search preferences live on the Jobs page. They are not onboarding
    // readiness or reset requirements.
    locations: false,
    target_roles: false,
    search_mode: "keywords_and_profile",
    work_modes: false,
    role_families: false,
    target_seniority: false,
    preferences_complete: true,
    cv_families: families,
    source_document_extracted: sourceDocuments > 0,
    external_connections_required: false,
  };
}
