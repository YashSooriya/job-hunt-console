export type DataMode = "auto" | "local" | "supabase";

export function getDataMode(): DataMode {
  const value = process.env.JOBHUNT_DATA_MODE?.toLowerCase();
  return value === "local" || value === "supabase" ? value : "auto";
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );
}

/**
 * Expose password sign-in only to an explicitly enabled local development run.
 * This keeps the synthetic-account test path out of production and prevents it
 * from being enabled against a hosted Supabase project.
 */
export function isLocalTestAuthEnabled() {
  if (process.env.NODE_ENV !== "development" || process.env.JOBHUNT_TEST_AUTH !== "true") return false;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
