export type EmailClassification = "confirmation" | "rejection" | "assessment" | "interview" | "offer" | "recruiter_message" | "other" | "uncertain";
export interface RecruitingEmailInput { id?: string; threadId?: string | null; sender?: string | null; subject?: string | null; snippet?: string | null; body?: string | null; receivedAt?: string | null; }
export interface ClassificationResult { classification: EmailClassification; confidence: number; reason: string; extracted: { externalJobId: string | null; roleHint: string | null; companyHint: string | null; deadlineAt: string | null; providerHint: string | null; }; }
export interface ApplicationCandidate { id: string; company: string; role: string; externalJobId?: string | null; appliedAt?: string | null; state?: string | null; }
export interface MatchResult { applicationId: string | null; confidence: number; reason: string; method: string; alternatives: Array<{ applicationId: string; confidence: number; reason: string }>; }
export function classifyRecruitingEmail(email: RecruitingEmailInput): ClassificationResult;
export function matchEmailToApplication(email: RecruitingEmailInput, classification: ClassificationResult, applications: ApplicationCandidate[]): MatchResult;
export function emailRequiresUser(classification: ClassificationResult, match: MatchResult): boolean;
