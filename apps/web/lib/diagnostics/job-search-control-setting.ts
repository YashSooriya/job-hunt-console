export type JobSearchControlBoolean = "manual_search_cooldown_disabled" | "testing_mode_enabled";

export async function writeJobSearchControlBoolean(
  supabase: any,
  userId: string,
  field: JobSearchControlBoolean,
  value: boolean,
) {
  const setting = { [field]: value, updated_at: new Date().toISOString() };
  const { data: updated, error: updateError } = await supabase
    .from("job_search_controls")
    .update(setting)
    .eq("user_id", userId)
    .select(field)
    .maybeSingle();
  if (updateError) throw updateError;
  if (updated) return updated[field] === true;

  const { data: inserted, error: insertError } = await supabase
    .from("job_search_controls")
    .insert({ user_id: userId, ...setting })
    .select(field)
    .maybeSingle();
  if (insertError?.code === "23505") {
    // Another diagnostics control may have inserted the owner's first row.
    const { data: retried, error: retryError } = await supabase
      .from("job_search_controls")
      .update(setting)
      .eq("user_id", userId)
      .select(field)
      .maybeSingle();
    if (retryError) throw retryError;
    if (retried) return retried[field] === true;
    throw insertError;
  }
  if (insertError) throw insertError;
  if (!inserted) throw new Error("The diagnostics setting could not be saved.");
  return inserted[field] === true;
}
