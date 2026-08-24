export declare const REVIEW_CENTER_CONTRACT_VERSION: string;
export declare function buildReviewChecklist(input: any): {
  contractVersion: string;
  state: string | null;
  checklist: Array<{key:string;label:string;complete:boolean}>;
  completed: number;
  total: number;
  canApprove: boolean;
  unresolvedCount: number;
};
