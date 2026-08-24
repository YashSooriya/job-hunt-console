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
