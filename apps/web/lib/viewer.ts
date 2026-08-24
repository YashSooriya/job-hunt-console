import { isSupabaseConfigured } from "@/lib/config";
import { getMembership } from "@/lib/access";
import type { Viewer } from "@/lib/types";

export async function getViewer(): Promise<Viewer> {
  if (!isSupabaseConfigured()) {
    return { configured: false, authenticated: false, email: null, authorized: true, role: "owner", canManageMembers: true };
  }

  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = error ? null : data?.claims;
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
  if (!claims) return { configured: true, authenticated: false, email, authorized: false, role: null, canManageMembers: false };
  const membership = await getMembership();
  return {
    configured: true,
    authenticated: true,
    email,
    authorized: membership.active,
    role: membership.role,
    canManageMembers: membership.can_manage_members,
  };
}
