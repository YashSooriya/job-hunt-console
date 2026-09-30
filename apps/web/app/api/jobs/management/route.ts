import { NextResponse } from "next/server";
import { updateLocalJobs } from "@/lib/data/local";
import { getDataMode, isSupabaseConfigured } from "@/lib/config";
import { requireProfile, statusCode } from "@/lib/onboarding/server";
import type { JobUserStatus } from "@/lib/types";
import { recordJobPoolSheetSyncInBackground } from "@/lib/google-job-pool-sheet";

const USER_STATUSES = new Set<JobUserStatus>([
  "new", "reviewing", "interested", "not_interested", "applied", "closed",
]);

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireProfile();
    const body = await request.json();
    const incomingIds: unknown[] = Array.isArray(body?.ids) ? body.ids : [];
    const ids = [...new Set(incomingIds.filter((id): id is string => typeof id === "string" && id.length <= 80))];
    if (!ids.length || ids.length > 100) {
      return NextResponse.json({ ok: false, error: "Select between 1 and 100 vacancies." }, { status: 400 });
    }

    let changes: Record<string, unknown>;
    if (body.action === "archive") changes = { archived_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    else if (body.action === "restore") changes = { archived_at: null, updated_at: new Date().toISOString() };
    else if (body.action === "status" && USER_STATUSES.has(body.status)) {
      changes = { user_status: body.status, updated_at: new Date().toISOString() };
    } else {
      return NextResponse.json({ ok: false, error: "Choose archive, restore, or a valid job status." }, { status: 400 });
    }

    if (getDataMode() === "local" || !isSupabaseConfigured()) {
      const localChanges = body.action === "archive"
        ? { archivedAt: changes.archived_at as string }
        : body.action === "restore"
          ? { archivedAt: null }
          : { userStatus: body.status as JobUserStatus };
      const updated = await updateLocalJobs(ids, localChanges);
      return NextResponse.json({ ok: true, updated });
    }

    const { data, error } = await supabase
      .from("jobs")
      .update(changes)
      .eq("user_id", user.id)
      .in("id", ids)
      .select("id");
    if (error) throw error;
    if ((data || []).length !== ids.length) {
      return NextResponse.json({ ok: false, error: "One or more vacancies could not be found." }, { status: 404 });
    }
    await recordJobPoolSheetSyncInBackground(supabase, user.id);
    return NextResponse.json({ ok: true, updated: data.length });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to update the job pool." }, {
      status: statusCode(error),
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
