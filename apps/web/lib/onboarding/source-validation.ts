import { text } from "@/lib/onboarding/server";

/**
 * Keep LinkedIn input validation in one place so staging and profile-build
 * requests apply exactly the same URL contract.
 */
export function normaliseLinkedInUrl(value: unknown) {
  const raw = text(value, 2000);
  if (!raw) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid LinkedIn profile URL."); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) || !/^\/in\/[^/]+/i.test(url.pathname)) {
    throw new Error("Enter a public LinkedIn profile URL such as https://www.linkedin.com/in/your-name.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Produce a stable, non-sensitive revision for the saved onboarding source
 * bundle.  This deliberately uses a small local hash instead of a platform
 * crypto dependency so it works in the Next/OpenNext runtime as well as in
 * tests.  The digest is only a concurrency/version marker; source contents
 * are never returned in it.
 */
export function sourceBundleDigest(input: {
  documents?: Array<Record<string, unknown>>;
  linkedinUrl?: string | null;
  additionalInformation?: string | null;
}) {
  const value = JSON.stringify({
    documents: (input.documents || []).map((document) => ({
      id: document.id || null,
      sha256: document.sha256 || null,
      updated_at: document.updated_at || null,
      extraction_status: document.extraction_status || null,
    })),
    linkedinUrl: input.linkedinUrl || null,
    additionalInformation: input.additionalInformation || null,
  });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sources-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
