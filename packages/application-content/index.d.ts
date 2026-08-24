export const APPLICATION_CONTENT_CONTRACT_VERSION: string;
export const APPLICATION_CONTENT_ENGINE_VERSION: string;
export function trustColour(trust: string): "green" | "amber" | "red";
export function buildSalaryContext(args: any): any;
export function generateCoverLetter(args: any): any;
export function buildScreeningPackage(args: any): any;
export function renderCoverLetterLatex(structured: any): string;
export function collectCoverLetterEvidenceLinks(structured: any): Array<{claimKey:string;evidenceId:string}>;
