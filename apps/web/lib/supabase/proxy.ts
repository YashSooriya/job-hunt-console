import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/config";

const publicPaths = ["/login", "/auth/callback", "/auth/signout", "/api/health"];
function isPublicPath(pathname: string) {
  return publicPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function updateSession(request: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          response.headers.set("Cache-Control", "private, no-store");
        },
      },
    }
  );

  const { data, error } = await supabase.auth.getClaims();
  const claims = error ? null : data?.claims;
  if (!claims && !isPublicPath(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  if (claims && !isPublicPath(request.nextUrl.pathname)) {
    const { data: membership, error: membershipError } = await supabase.rpc("get_my_membership");
    if (membershipError || !(membership as any)?.active) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("error", (membership as any)?.status === "revoked" ? "revoked" : "not-member");
      return NextResponse.redirect(url);
    }
  }

  return response;
}
