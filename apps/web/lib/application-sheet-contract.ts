import { createHash } from "node:crypto";

export type ApplicationSheetPublicationDecision = "publish" | "already_current" | "external_edit" | "unverified_existing_data";

export function applicationSheetHash(values: unknown[][]) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function normalizeApplicationValues(values: unknown[][], columnCount: number) {
  return values.map((raw) => {
    const row = Array.isArray(raw) ? raw.slice(0, columnCount) : [];
    while (row.length < columnCount) row.push("");
    return row.map((value) => value === null || value === undefined ? "" : value);
  });
}

export function applicationManifestHash(values: unknown[][]) {
  return String(values.find((row) => row?.[0] === "content_hash")?.[1] || "");
}

export function applicationSheetPublicationDecision(input: {
  existingValues: unknown[][];
  existingManifest: unknown[][];
  desiredHash: string;
  expectedHash?: string | null;
  columnCount: number;
}): ApplicationSheetPublicationDecision {
  const existingHash = input.existingValues.length
    ? applicationSheetHash(normalizeApplicationValues(input.existingValues, input.columnCount))
    : "";
  const manifestHash = applicationManifestHash(input.existingManifest);
  const hasRows = input.existingValues.slice(1).some((row) => Array.isArray(row) && row.some((value) => value !== null && value !== undefined && value !== ""));
  const hasManifest = input.existingManifest.length > 1;
  if (existingHash === input.desiredHash && manifestHash === input.desiredHash) return "already_current";
  if (input.expectedHash && existingHash === input.expectedHash && manifestHash === input.expectedHash) return "publish";
  if (input.expectedHash) return "external_edit";
  if (hasRows || hasManifest) return "unverified_existing_data";
  return "publish";
}
