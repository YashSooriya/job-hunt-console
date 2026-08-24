export const APPLICATION_PREPARATION_CONTRACT_VERSION: string;
export type PreparationTaskState = "pending" | "running" | "completed" | "retrying" | "needs_user" | "failed";
export type PreparationTask = {
  taskType: string;
  state: PreparationTaskState;
  label: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
};
export type PreparationPlan = {
  contractVersion: string;
  origin: "manual" | "auto_prepare";
  state: "preparing";
  jobId: string;
  jobAnalysisId: string | null;
  selectedCvFamily: "simulation_cae" | "scientific_software" | "quantitative_data" | "motorsport";
  strategyText: string;
  evidenceIds: string[];
  nextAction: string;
  tasks: PreparationTask[];
};
export function buildApplicationPreparationPlan(job: any, options?: { origin?: "manual" | "auto_prepare" }): PreparationPlan;
export function preparationProgress(tasks?: Array<{ state: PreparationTaskState }>): { total: number; completed: number; pending: number; needsUser: number; failed: number; percent: number };
