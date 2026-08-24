import { isSupabaseConfigured } from "@/lib/config";

export type AppRole = "owner" | "admin" | "member";

export type AppMembership = {
  authenticated: boolean;
  active: boolean;
  role: AppRole | null;
  email: string | null;
  status?: "active" | "revoked" | null;
  joined_at?: string | null;
  can_manage_members: boolean;
};

export async function getMembership(): Promise<AppMembership> {
  if (!isSupabaseConfigured()) {
    return { authenticated: false, active: true, role: "owner", email: null, can_manage_members: true };
  }
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_membership");
  if (error) {
    return { authenticated: true, active: false, role: null, email: null, can_manage_members: false };
  }
  const value = (data || {}) as Partial<AppMembership>;
  return {
    authenticated: Boolean(value.authenticated),
    active: Boolean(value.active),
    role: value.role === "owner" || value.role === "admin" || value.role === "member" ? value.role : null,
    email: typeof value.email === "string" ? value.email : null,
    status: value.status === "active" || value.status === "revoked" ? value.status : null,
    joined_at: typeof value.joined_at === "string" ? value.joined_at : null,
    can_manage_members: Boolean(value.can_manage_members),
  };
}
