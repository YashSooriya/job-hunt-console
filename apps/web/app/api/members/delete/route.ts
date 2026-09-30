import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const userId = typeof body?.userId === "string" ? body.userId : "";
    if (!UUID_PATTERN.test(userId)) {
      return NextResponse.json({ ok: false, error: "Choose a valid member account." }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      return NextResponse.json({ ok: false, error: "Sign in as the app owner to continue." }, { status: 401 });
    }

    const { data, error } = await supabase.functions.invoke("member-account-delete", {
      body: { userId },
    });
    if (error) {
      const context = (error as { context?: unknown }).context;
      if (context instanceof Response) {
        const responseBody = await context.clone().json().catch(() => null) as { error?: unknown } | null;
        const message = typeof responseBody?.error === "string" ? responseBody.error : error.message;
        return NextResponse.json({ ok: false, error: message }, { status: context.status || 502 });
      }
      return NextResponse.json({ ok: false, error: error.message || "Account deletion did not finish." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, result: data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid account-deletion request." }, { status: 400 });
  }
}
