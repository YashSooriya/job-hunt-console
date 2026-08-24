export type JobUrlInspectionStatus = "queued" | "processing" | "completed" | "failed" | "user_required";

export function normalizeJobListingUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("A job listing URL is required.");
  if (raw.length > 2000) throw new Error("The job listing URL is too long.");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Enter a complete job listing URL beginning with https://.");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("Only http:// and https:// job listing URLs are supported.");
  }
  parsed.hash = "";
  return parsed.toString();
}

export function inspectionStatusLabel(status: JobUrlInspectionStatus) {
  switch (status) {
    case "queued": return "Queued for ChatGPT";
    case "processing": return "ChatGPT is reading the listing";
    case "completed": return "Listing imported";
    case "failed": return "Could not import listing";
    case "user_required": return "Needs your attention";
  }
}
