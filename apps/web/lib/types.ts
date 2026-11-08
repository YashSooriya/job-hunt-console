export type DataSource = "local_snapshot" | "supabase";

export type TrackerRecord = {
  id?: string;
  sourceRow: number | null;
  company: string;
  role: string;
  externalJobId: string | null;
  applicationDate: string | null;
  lastEmail: string | null;
  status: string;
  stage: string;
  priority: string;
  nextAction: string | null;
  deadline: string | null;
  daysSinceUpdate: number | null;
  notes: string | null;
  emailSource: string | null;
  applicationState: string;
};

export type TrackerSummary = {
  total: number;
  actionRequired: number;
  underReview: number;
  received: number;
  rejected: number;
  assessments: number;
  interviews: number;
};

export type TrackerQualityIssue = {
  sourceRow: number | null;
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
};

export type TrackerQuality = {
  issueCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: TrackerQualityIssue[];
};

export type TrackerDataset = {
  source: DataSource;
  generatedAt: string | null;
  summary: TrackerSummary;
  quality: TrackerQuality;
  records: TrackerRecord[];
};

export type CandidateFact = {
  id?: string;
  factKey: string;
  value: unknown;
  status: "verified" | "needs_review" | "rejected";
  sourceKey?: string | null;
};

export type EvidenceItem = {
  id?: string;
  evidenceKey: string;
  category: string;
  claim: string;
  detail: string | null;
  tags: string[];
  strength: number;
  status: "verified" | "needs_review" | "rejected";
  sourceKey?: string | null;
  sourceLocator?: string | null;
};

export type EvidenceSource = {
  id?: string;
  sourceKey: string;
  title: string;
  sourceType: string;
  provider?: string | null;
};

export type CandidateProfileData = {
  source: DataSource;
  displayName: string;
  facts: CandidateFact[];
  evidence: EvidenceItem[];
  sources: EvidenceSource[];
  preferences: Record<string, unknown>;
  structured: {
    employment: Array<Record<string, unknown>>;
    education: Array<Record<string, unknown>>;
    skills: Array<Record<string, unknown>>;
    projects: Array<Record<string, unknown>>;
    publications: Array<Record<string, unknown>>;
  };
};

export type Viewer = {
  configured: boolean;
  authenticated: boolean;
  email: string | null;
  authorized: boolean;
  role: "owner" | "admin" | "member" | null;
  canManageMembers: boolean;
};

export type JobTriage = "auto_prepare" | "recommend" | "maybe" | "reject";
export type JobUserStatus = "new" | "reviewing" | "interested" | "not_interested" | "applied" | "closed";
export type CvFamily = "simulation_cae" | "scientific_software" | "quantitative_data" | "motorsport";
export type EligibilityState = "eligible" | "eligible_with_concerns" | "unknown" | "ineligible";

export type JobRequirementRecord = {
  id?: string;
  text: string;
  type: "essential" | "desirable" | "context" | "eligibility";
  category: string;
  matchScore: number | null;
  matchLabel?: string | null;
  evidenceQuotes?: Array<{ reference: string; quote: string }>;
  matchExplanation?: string | null;
  evidenceIds: string[];
};

export type JobAnalysisRecord = {
  id?: string;
  contractVersion: string;
  analysisSource: string;
  eligibility: EligibilityState;
  eligibilityNotes: string[];
  fitScore: number | null;
  priorityScore: number | null;
  fitComponents: Record<string, number | null>;
  fitComponentDetails?: Record<string, { score: number | null; state: string; explanation: string }>;
  priorityComponents: Record<string, number | null>;
  recommendedCvFamily: CvFamily;
  strengths: Array<{ description: string; evidenceIds: string[] }>;
  weaknesses: Array<{ description: string; severity: "low" | "medium" | "high" }>;
  applicationStrategy: string;
  coverLetterValue: "high" | "medium" | "low" | "not_accepted";
  evidenceIds: string[];
  triage: JobTriage;
  triageReason: string;
  engineVersion?: string | null;
  jobRevision?: number | null;
  profileRevision?: number | null;
  inputHash?: string | null;
  assessedAt?: string | null;
  createdAt?: string | null;
  assessmentCompleteness?: "complete" | "partial" | null;
  assessmentLimitations?: string[];
};

export type JobAnalysisStatus = "pending" | "current" | "outdated";

export type JobRecord = {
  id: string;
  company: string;
  title: string;
  industry: string | null;
  externalJobId: string | null;
  sourceUrl: string | null;
  applicationUrl: string | null;
  location: string | null;
  workMode: string | null;
  salaryText: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salarySource?: "advertised" | "chatgpt_estimate" | "not_available" | string | null;
  salaryConfidence?: "high" | "medium" | "low" | string | null;
  salaryBasis?: string[];
  postedAt: string | null;
  closesAt: string | null;
  employmentType: string | null;
  atsProvider: string | null;
  discoverySource: string;
  dedupeKey: string | null;
  discoveredAt: string;
  triage: JobTriage | null;
  triageReason: string | null;
  userStatus?: JobUserStatus;
  archivedAt?: string | null;
  analysisStatus?: JobAnalysisStatus;
  description: string;
  snapshotCapturedAt?: string | null;
  listingSummary?: string | null;
  responsibilities?: string[];
  extractedRequirements?: string[];
  desirableRequirements?: string[];
  skills?: string[];
  benefits?: string[];
  applicationInstructions?: string | null;
  listingExtractionSource?: string | null;
  listingExtractedAt?: string | null;
  analysis: JobAnalysisRecord | null;
  requirements: JobRequirementRecord[];
};

export type JobSummary = {
  total: number;
  autoPrepare: number;
  recommend: number;
  maybe: number;
  reject: number;
};

export type JobDataset = {
  source: DataSource;
  generatedAt: string | null;
  summary: JobSummary;
  records: JobRecord[];
};

export type PreparationTaskState = "pending" | "running" | "completed" | "retrying" | "needs_user" | "failed";

export type ApplicationPreparationTask = {
  id?: string;
  taskType: string;
  state: PreparationTaskState;
  label: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type PreparationApplicationRecord = {
  id: string;
  jobId: string;
  company: string;
  role: string;
  state: string;
  origin: "manual" | "auto_prepare" | "historical_import" | null;
  chosenToApplyAt: string | null;
  selectedCvFamily: CvFamily | null;
  strategyText: string;
  evidenceIds: string[];
  nextAction: string | null;
  notes: string | null;
  salaryText: string | null;
  fitScore: number | null;
  priorityScore: number | null;
  triage: JobTriage | null;
  jobSnapshotId: string | null;
  jobAnalysisId: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: ApplicationPreparationTask[];
  progress: { total: number; completed: number; pending: number; needsUser: number; failed: number; percent: number };
};

export type PreparationApplicationDataset = {
  source: DataSource;
  generatedAt: string | null;
  summary: { total: number; autoPrepared: number; preparing: number; readyForReview: number; needsUser: number };
  records: PreparationApplicationRecord[];
};

export type DocumentVersionRecord = {
  id: string;
  documentId: string;
  versionNumber: number;
  structuredContent: Record<string, any>;
  latexSource: string | null;
  renderedObjectKey: string | null;
  engine: string | null;
  contractVersion: string | null;
  changeSummary: Array<{ area: string; change_type: string; reason: string }>;
  approvalStatus: string;
  approvedAt?: string | null;
  unsupportedClaimsCount: number;
  submissionLockedAt: string | null;
  createdAt: string;
  evidenceLinks: Array<{ claimKey: string; evidenceId: string }>;
};

export type DocumentRecord = {
  id: string;
  applicationId: string | null;
  profileId: string | null;
  kind: string;
  title: string;
  cvFamily: CvFamily | null;
  createdAt: string;
  versions: DocumentVersionRecord[];
};

export type DocumentDataset = {
  source: DataSource;
  generatedAt: string | null;
  records: DocumentRecord[];
};

export type SalaryContextRecord = {
  source: "advertised" | "estimated" | "user_provided";
  advertisedText: string | null;
  estimatedLow: number | null;
  estimatedHigh: number | null;
  recommendedValue: number | null;
  currency: string;
  confidence: "low" | "medium" | "high";
  trust: "verified" | "proposed" | "user_required";
  basis: string[];
  approvedAt: string | null;
};

export type ScreeningAnswerRecord = {
  id?: string;
  questionKey: string | null;
  questionText: string;
  answerText: string | null;
  required: boolean;
  trust: "verified" | "proposed" | "user_required";
  category: string | null;
  colour: "green" | "amber" | "red";
  rationale: string | null;
  evidenceIds: string[];
  approvedAt: string | null;
};

export type ApplicationContentPackage = {
  source: DataSource;
  salary: SalaryContextRecord | null;
  answers: ScreeningAnswerRecord[];
  coverLetter: DocumentRecord | null;
  unresolvedRequired: number;
};

export type ApplicationReviewPackage = {
  source: DataSource;
  applicationId: string;
  cvVersionId: string | null;
  coverLetterVersionId: string | null;
  coverLetterDecision: "use" | "remove" | "not_required";
  assembledAt: string | null;
  approvedAt: string | null;
  checklist: Array<{ key: string; label: string; complete: boolean }>;
  completed: number;
  total: number;
  canApprove: boolean;
  unresolvedCount: number;
};

export type EmailActivityRecord = {
  id: string;
  providerMessageId: string;
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
  classification: "confirmation" | "rejection" | "assessment" | "interview" | "offer" | "recruiter_message" | "other" | "uncertain" | null;
  confidence: number | null;
  classificationReason: string | null;
  classificationSource: "deterministic" | "chatgpt" | "user" | string | null;
  classificationModel: string | null;
  chatgptClassifiedAt: string | null;
  needsUser: boolean;
  autoAppliedAt: string | null;
  proposedState: string | null;
  applicationId: string | null;
  company: string | null;
  role: string | null;
  matchConfidence: number | null;
  matchMethod: string | null;
  matchReason: string | null;
};

export type EmailMonitoringDataset = {
  source: DataSource;
  status: "never_synced" | "syncing" | "ok" | "needs_reconnect" | "error" | "local_snapshot";
  lastSyncedAt: string | null;
  lastError: string | null;
  summary: { total: number; relevant: number; needsUser: number; autoUpdated: number };
  records: EmailActivityRecord[];
};

export type ProgressionContextQuality = "exact_submitted" | "approved_pre_submission" | "best_available";

export type ProgressionPreparationVersion = {
  id: string;
  versionNumber: number;
  contextQuality: ProgressionContextQuality;
  contextSnapshot: Record<string, any>;
  preparationPackage: Record<string, any>;
  generator: string;
  createdAt: string;
};

export type AssessmentWorkspaceRecord = {
  id: string;
  applicationId: string;
  company: string;
  role: string;
  provider: string | null;
  assessmentType: string | null;
  invitedAt: string | null;
  deadlineAt: string | null;
  estimatedMinutes: number | null;
  status: "pending" | "in_progress" | "completed" | "expired" | "cancelled";
  preparationStatus: "not_prepared" | "prepared" | "completed";
  notes: string | null;
  sourceEmailId: string | null;
  currentPreparationVersionId: string | null;
  preparationVersions: ProgressionPreparationVersion[];
};

export type InterviewWorkspaceRecord = {
  id: string;
  applicationId: string;
  company: string;
  role: string;
  interviewType: string | null;
  roundLabel: string | null;
  scheduledAt: string | null;
  participants: any[];
  status: "scheduled" | "completed" | "cancelled" | "rescheduled";
  preparationStatus: "not_prepared" | "prepared" | "completed";
  notes: string | null;
  sourceEmailId: string | null;
  currentPreparationVersionId: string | null;
  preparationVersions: ProgressionPreparationVersion[];
};

export type ProgressionDataset = {
  source: DataSource;
  generatedAt: string | null;
  summary: { assessments: number; interviews: number; dueSoon: number; needsPreparation: number };
  assessments: AssessmentWorkspaceRecord[];
  interviews: InterviewWorkspaceRecord[];
};
