import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { deleteMemberStorageObjects } from "../_shared/member-account-storage.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const PUBLIC_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getBearerToken(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "Use POST for account deletion." }, 405);
  if (!SUPABASE_URL || !PUBLIC_KEY || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Account deletion is not configured on the server." }, 503);
  }

  const token = getBearerToken(request);
  if (!token) return json({ ok: false, error: "Sign in as the app owner to continue." }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "The deletion request is invalid." }, 400);
  }
  const userId = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).userId
    : null;
  if (!isUuid(userId)) return json({ ok: false, error: "Choose a valid member account." }, 400);

  const userClient = createClient(SUPABASE_URL, PUBLIC_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !authData.user) return json({ ok: false, error: "Your sign-in could not be verified. Sign in again." }, 401);
  if (authData.user.id === userId) return json({ ok: false, error: "You cannot delete your own account here." }, 400);

  const { data: membership, error: membershipError } = await userClient.rpc("get_my_membership");
  if (membershipError || !membership?.active || membership?.role !== "owner") {
    return json({ ok: false, error: "Only the active app owner can permanently delete a member account." }, 403);
  }

  const { data: prepared, error: prepareError } = await userClient.rpc("manage_app_member", {
    p_action: "prepare_delete",
    p_user_id: userId,
    p_role: null,
  });
  if (prepareError || !prepared?.prepared) {
    const missing = prepared?.reason === "not_found";
    return json({
      ok: false,
      error: missing
        ? "That member no longer exists. Refresh the Members page."
        : "The account could not be prepared for deletion. Refresh and try again.",
    }, missing ? 404 : 403);
  }

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // The preparation RPC has revoked membership, paused scheduled searches,
    // and the Storage policies now deny the target's still-valid JWT.
    await deleteMemberStorageObjects(serviceClient.storage, userId);
  } catch (error) {
    console.error("Member storage cleanup failed", error instanceof Error ? error.name : "unknown error");
    return json({
      ok: false,
      error: "The member is safely revoked, but their stored files could not all be removed yet. The account has not been deleted; retry this action to continue.",
    }, 502);
  }

  const { error: finalizeError } = await userClient.rpc("manage_app_member", {
    p_action: "finalize_delete",
    p_user_id: userId,
    p_role: null,
  });
  if (finalizeError) {
    console.error("Member credential cleanup failed", finalizeError.name);
    return json({
      ok: false,
      error: "The member's files are removed and access is revoked, but credential cleanup did not finish. Retry this action to continue.",
    }, 502);
  }

  const { error: deleteError } = await serviceClient.auth.admin.deleteUser(userId);
  if (deleteError) {
    console.error("Auth member deletion failed", deleteError.name);
    return json({
      ok: false,
      error: "The member's files and credentials are removed and access is revoked, but Auth could not finish deleting the account. Retry this action to continue.",
    }, 502);
  }

  return json({ ok: true, deleted: true, userId });
});
