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
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Only http:// and https:// job listing URLs are supported.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
    || hostname.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    throw new Error("Enter a public job listing URL; private and local addresses cannot be sent to the Website Bridge.");
  }
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key.toLowerCase())) parsed.searchParams.delete(key);
  parsed.searchParams.sort();
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
